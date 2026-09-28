import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { VfsPluginRequest } from '@opfs-vfs/opfs-vfs/plugins';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { subscribe, type Subscription } from '@opfs-vfs/plugin-subscriptions/client';
import { VolumeProvider, useFileContent, useFolder } from '@opfs-vfs/react';

type Mode = 'direct' | 'sdk';
type Config = Readonly<{
  name: string;
  mode: Mode;
  resourceCount: number;
  entryCount: number;
  contentSize: number;
  writes: number;
}>;
type Direction = 'sent' | 'received';
type Transport = 'worker' | 'broadcast';
type Counts = Record<string, number>;
type TransportMetrics = Record<
  Transport,
  Record<Direction, { messages: number; binaryBytes: number; deliveries: number; duplicates: number }>
>;
type BenchmarkRuntime = Readonly<{
  worker(): Worker;
  plugins(): readonly VfsPluginRequest[];
}>;
const cleanupError = (failures: readonly unknown[], label: string) =>
  new AggregateError(
    failures,
    `${label}: ${failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
  );

declare global {
  interface Window {
    __OPFS_VFS_BENCHMARK_RUNTIME?: BenchmarkRuntime;
    __OPFS_VFS_BENCHMARK_REQUIRE_RUNTIME?: boolean;
    __OPFS_VFS_BENCHMARK_CAPTURE_OVERLAP?: () => Promise<void>;
    reactSdkBenchmark: {
      seed(config: Config): Promise<void>;
      run(config: Config): Promise<unknown>;
      openTab(config: Pick<Config, 'name' | 'mode'>): Promise<void>;
      writeTab(value: number): Promise<void>;
      waitTab(value: number): Promise<void>;
      closeTab(): Promise<void>;
      deleteTabVolume(name: string): Promise<void>;
    };
  }
}

const defaultRuntime: BenchmarkRuntime = {
  worker: () => new Worker(new URL('./volume-worker.ts', import.meta.url), { type: 'module' }),
  plugins: () => [subscriptionsRequest()],
};
const runtime = () => {
  const configured = window.__OPFS_VFS_BENCHMARK_RUNTIME;
  if (configured) return configured;
  if (window.__OPFS_VFS_BENCHMARK_REQUIRE_RUNTIME)
    throw new Error('Benchmark setup module did not configure a runtime');
  return defaultRuntime;
};
async function retire(vfs: OpfsVfsWorker, subscription?: Subscription) {
  const failures: unknown[] = [];
  if (subscription) {
    try {
      subscription.unsubscribe();
    } catch (error) {
      failures.push(error);
    }
    try {
      await subscription.closed;
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await vfs.closeVfs();
  } catch (error) {
    failures.push(error);
  }
  try {
    vfs.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw cleanupError(failures, 'Benchmark VFS cleanup failed');
}
async function cleanup(...actions: readonly (() => Promise<void>)[]) {
  const failures: unknown[] = [];
  for (const action of actions)
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length) throw cleanupError(failures, 'Benchmark cleanup failed');
}
const waitFor = async (check: () => boolean | Promise<boolean>, label: string, timeout = 30_000) => {
  const until = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > until) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function binaryBytes(value: unknown, seen = new Set<object>()): number {
  const add = (buffer: object, bytes: number) => {
    if (seen.has(buffer)) return 0;
    seen.add(buffer);
    return bytes;
  };
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return add(value, value.byteLength);
  if (ArrayBuffer.isView(value)) return add(value.buffer, value.byteLength);
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((total, entry) => total + binaryBytes(entry, seen), 0);
  return Object.values(value).reduce((total, entry) => total + binaryBytes(entry, seen), 0);
}

function messageCommands(
  value: unknown,
  seen = new Set<object>(),
  found: { type: string; path?: string }[] = [],
): readonly { type: string; path?: string }[] {
  if (
    !value ||
    typeof value !== 'object' ||
    seen.has(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  )
    return found;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry) => messageCommands(entry, seen, found));
  else {
    const entry = value as { type?: unknown; path?: unknown; payload?: { path?: unknown } };
    if (typeof entry.type === 'string') {
      const path = typeof entry.path === 'string' ? entry.path : entry.payload?.path;
      found.push(typeof path === 'string' ? { type: entry.type, path } : { type: entry.type });
    }
    Object.values(value).forEach((child) => messageCommands(child, seen, found));
  }
  return found;
}

// Fail a benchmark run if its counter starts enumerating binary payloads again.
const binaryProbe = new Uint8Array(1);
const objectValues = Object.values;
try {
  Object.values = ((value: object) => {
    if (value === binaryProbe) throw new Error('Benchmark counter walked a binary payload');
    return objectValues(value);
  }) as typeof Object.values;
  if (messageCommands({ type: 'PROBE', data: binaryProbe }).length !== 1)
    throw new Error('Benchmark counter missed a command');
} finally {
  Object.values = objectValues;
}

function recorder() {
  const commands: Counts = {};
  const transport: TransportMetrics = {
    worker: {
      sent: { messages: 0, binaryBytes: 0, deliveries: 0, duplicates: 0 },
      received: { messages: 0, binaryBytes: 0, deliveries: 0, duplicates: 0 },
    },
    broadcast: {
      sent: { messages: 0, binaryBytes: 0, deliveries: 0, duplicates: 0 },
      received: { messages: 0, binaryBytes: 0, deliveries: 0, duplicates: 0 },
    },
  };
  const broadcastDelivery = (duplicate: boolean) => {
    transport.broadcast.received.deliveries++;
    if (duplicate) transport.broadcast.received.duplicates++;
  };
  const note = (kind: Transport, direction: Direction, message: unknown) => {
    transport[kind][direction].messages++;
    transport[kind][direction].binaryBytes += binaryBytes(message);
    for (const command of messageCommands(message)) {
      commands[command.type] = (commands[command.type] ?? 0) + 1;
      if (command.path) {
        const key = `${command.type}:${command.path}`;
        commands[key] = (commands[key] ?? 0) + 1;
      }
    }
  };
  const reset = () => {
    for (const counts of Object.values(transport))
      for (const value of Object.values(counts)) {
        value.messages = 0;
        value.binaryBytes = 0;
        value.deliveries = 0;
        value.duplicates = 0;
      }
    for (const key of Object.keys(commands)) delete commands[key];
  };
  return { commands, transport, note, broadcastDelivery, reset };
}

/** Counts only page-boundary binary payloads; headers, cloned framing and worker-internal traffic are excluded. */
function instrument(record: ReturnType<typeof recorder>) {
  const NativeBroadcastChannel = BroadcastChannel;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')!;
  class CountedBroadcastChannel extends NativeBroadcastChannel {
    #listeners = new Map<EventListenerOrEventListenerObject, EventListener>();
    #received = new WeakSet<MessageEvent>();
    #onmessage: ((this: BroadcastChannel, event: MessageEvent) => unknown) | null = null;
    override postMessage(message: unknown) {
      record.note('broadcast', 'sent', message);
      super.postMessage(message);
    }
    #receive(event: MessageEvent) {
      const duplicate = this.#received.has(event);
      record.broadcastDelivery(duplicate);
      if (duplicate) return;
      this.#received.add(event);
      record.note('broadcast', 'received', event.data);
    }
    override set onmessage(listener) {
      this.#onmessage = listener;
      super.onmessage = listener
        ? (event) => {
            this.#receive(event);
            listener.call(this, event);
          }
        : null;
    }
    override get onmessage() {
      return this.#onmessage;
    }
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: AddEventListenerOptions | boolean,
    ) {
      if (type !== 'message') {
        if (listener) super.addEventListener(type, listener, options);
        return;
      }
      if (!listener) return;
      const wrapped: EventListener = (event) => {
        this.#receive(event as MessageEvent);
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      };
      this.#listeners.set(listener, wrapped);
      super.addEventListener(type, wrapped, options);
    }
    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: EventListenerOptions | boolean,
    ) {
      if (!listener) return;
      super.removeEventListener(type, this.#listeners.get(listener) ?? listener, options);
      if (listener) this.#listeners.delete(listener);
    }
  }
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: CountedBroadcastChannel });
  const countedWorker = () => {
    const endpoint = runtime().worker();
    const post = endpoint.postMessage.bind(endpoint);
    endpoint.postMessage = ((message: unknown, transfer?: StructuredSerializeOptions | Transferable[]) => {
      record.note('worker', 'sent', message);
      post(message, transfer as StructuredSerializeOptions | undefined);
    }) as Worker['postMessage'];
    let prototype: object | null = endpoint;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype && !(descriptor = Object.getOwnPropertyDescriptor(prototype, 'onmessage')))
      prototype = Object.getPrototypeOf(prototype);
    if (!descriptor?.set) throw new Error('Worker onmessage is not interceptable');
    let handler: ((this: Worker, event: MessageEvent) => unknown) | null = null;
    Object.defineProperty(endpoint, 'onmessage', {
      configurable: true,
      get: () => handler,
      set: (listener) => {
        handler = listener;
        descriptor.set!.call(
          endpoint,
          listener
            ? (event: MessageEvent) => {
                record.note('worker', 'received', event.data);
                listener.call(endpoint, event);
              }
            : null,
        );
      },
    });
    return endpoint;
  };
  return { countedWorker, restore: () => Object.defineProperty(globalThis, 'BroadcastChannel', original) };
}

async function seed(config: Config) {
  const vfs = new OpfsVfsWorker(config.name, {
    worker: runtime().worker,
    plugins: runtime().plugins(),
    bufferMode: 'memory',
  });
  try {
    await vfs.ready;
    await vfs.mkdir('/folder');
    await vfs.mkdir('/content');
    for (let index = 0; index < config.entryCount; index++)
      await vfs.writeFileBuffer(`/folder/${index}`, new Uint8Array([index]));
    for (let index = 0; index < config.resourceCount; index++)
      await vfs.writeFileBuffer(`/content/${index}`, new Uint8Array(config.contentSize).fill(index));
    await vfs.writeFileBuffer('/unrelated', new Uint8Array([0]));
    await vfs.writeFileBuffer('/live', new Uint8Array([0]));
  } finally {
    await retire(vfs);
  }
}

const commandCount = (commands: Counts, type: string) => commands[type] ?? 0;
const payload = (size: number, value: number) => new Uint8Array(size).fill(value);
const snapshotTransport = (transport: TransportMetrics) => structuredClone(transport);

async function direct(config: Config, record: ReturnType<typeof recorder>, countedWorker: () => Worker) {
  const started = performance.now();
  record.reset();
  const vfs = new OpfsVfsWorker(config.name, {
    worker: countedWorker,
    plugins: runtime().plugins(),
    bufferMode: 'memory',
  });
  await vfs.ready;
  const readyMs = performance.now() - started;
  let writer: OpfsVfsWorker | undefined;
  let events = 0;
  let latest = -1;
  let subscription: Subscription | undefined;
  let logicalReadBytes = 0;
  let logicalWriteBytes = 0;
  try {
    subscription = await subscribe(
      vfs,
      { path: '/', scope: 'directory', recursive: true, onError: () => {} },
      (change) => {
        if (change.path !== '/content/0') return;
        events++;
        void vfs.readFileBuffer('/content/0').then((value) => (latest = value[0] ?? -1));
      },
    );
    for (let index = 0; index < 100; index++) await vfs.readdirEntries('/folder');
    for (let index = 0; index < config.resourceCount; index++) {
      const value = await vfs.readFileBuffer(`/content/${index}`);
      logicalReadBytes += value.byteLength;
    }
    const initial = { commands: { ...record.commands }, transport: snapshotTransport(record.transport) };
    const resourcesMs = performance.now() - started;
    const writerClient = new OpfsVfsWorker(config.name, {
      worker: runtime().worker,
      plugins: runtime().plugins(),
      bufferMode: 'memory',
    });
    writer = writerClient;
    await writerClient.ready;
    record.reset();
    for (let index = 1; index <= config.writes; index++) {
      const value = payload(config.contentSize, index);
      logicalWriteBytes += value.byteLength;
      await writerClient.writeFileBuffer('/content/0', value);
      if (index % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 4));
    }
    const stoppedAt = performance.now();
    await waitFor(() => events > 0 && latest === config.writes, 'direct subscription convergence');
    const convergenceMs = performance.now() - stoppedAt;
    const updates = { commands: { ...record.commands }, transport: snapshotTransport(record.transport) };
    record.reset();
    const equalRefreshStartedAt = performance.now();
    const unchanged = await vfs.readFileBuffer('/content/0');
    const equalRefresh = {
      phase: 'unchanged direct read',
      ms: performance.now() - equalRefreshStartedAt,
      bytes: unchanged.byteLength,
      finalByte: unchanged[0] ?? -1,
      commands: { ...record.commands },
      transport: snapshotTransport(record.transport),
    };
    if (equalRefresh.finalByte !== config.writes)
      throw new Error('Unchanged direct read did not return the final byte');
    return {
      startup: { readyMs, resourcesMs },
      convergenceMs,
      logical: { readBytes: logicalReadBytes, writeBytes: logicalWriteBytes },
      initial,
      commands: updates.commands,
      transport: updates.transport,
      equalRefresh,
      assertions: { directConsumers: commandCount(initial.commands, 'READDIR_ENTRIES:/folder') === 100, events },
    };
  } finally {
    const writerToRetire = writer;
    await cleanup(...(writerToRetire ? [() => retire(writerToRetire)] : []), () => retire(vfs, subscription));
  }
}

type Dashboard = {
  folders: Set<number>;
  content: Set<number>;
  replacements: number;
  latest: number;
  current: Uint8Array | null;
  previous: Uint8Array | null;
  readyAtMs: number | null;
  close: (() => Promise<void>) | null;
  unrelated: number | null;
  resource0Refresh: (() => Promise<void>) | null;
  marks: { oldNewOverlapMs: number | null };
};
function FolderConsumer({ index, dashboard }: { index: number; dashboard: Dashboard }) {
  const result = useFolder('/folder');
  if (result.status === 'success') dashboard.folders.add(index);
  return null;
}
function ContentConsumer({ index, dashboard }: { index: number; dashboard: Dashboard }) {
  const result = useFileContent(`/content/${index}`);
  if (result.status === 'success' && result.data instanceof Uint8Array) {
    dashboard.content.add(index);
    if (index === 0) dashboard.resource0Refresh = result.refresh;
    if (index === 0 && dashboard.current !== result.data) {
      if (dashboard.current) {
        dashboard.previous = dashboard.current;
        dashboard.marks.oldNewOverlapMs = performance.now();
        dashboard.replacements++;
      }
      dashboard.current = result.data;
      dashboard.latest = result.data[0] ?? -1;
    }
  }
  return null;
}
function UnrelatedConsumer({ dashboard }: { dashboard: Dashboard }) {
  const result = useFileContent('/unrelated');
  if (result.status === 'success' && result.data instanceof Uint8Array) dashboard.unrelated = result.data[0] ?? -1;
  return null;
}
function BenchmarkView({
  config,
  dashboard,
  workerFactory,
}: {
  config: Config;
  dashboard: Dashboard;
  workerFactory: () => Worker;
}) {
  return (
    <VolumeProvider
      fileName={config.name}
      worker={workerFactory}
      plugins={runtime().plugins()}
      options={{ bufferMode: 'memory' }}
    >
      {(volume) => {
        if (volume.ownership === 'managed') dashboard.close = volume.close;
        if (volume.status === 'ready' && dashboard.readyAtMs === null) dashboard.readyAtMs = performance.now();
        return (
          <>
            {Array.from({ length: 100 }, (_, index) => (
              <FolderConsumer key={index} index={index} dashboard={dashboard} />
            ))}
            {Array.from({ length: config.resourceCount }, (_, index) => (
              <ContentConsumer key={index} index={index} dashboard={dashboard} />
            ))}
            <UnrelatedConsumer dashboard={dashboard} />
          </>
        );
      }}
    </VolumeProvider>
  );
}

async function sdk(config: Config, record: ReturnType<typeof recorder>, countedWorker: () => Worker) {
  const dashboard: Dashboard = {
    folders: new Set(),
    content: new Set(),
    replacements: 0,
    latest: -1,
    current: null,
    previous: null,
    readyAtMs: null,
    close: null,
    unrelated: null,
    resource0Refresh: null,
    marks: { oldNewOverlapMs: null },
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const view = () => <BenchmarkView config={config} dashboard={dashboard} workerFactory={countedWorker} />;
  const started = performance.now();
  record.reset();
  root.render(view());
  await waitFor(
    () => dashboard.folders.size === 100 && dashboard.content.size === config.resourceCount,
    'SDK initial resources',
  );
  if (dashboard.readyAtMs === null || !dashboard.close)
    throw new Error('Managed volume did not expose readiness and close');
  const startup = { readyMs: dashboard.readyAtMs - started, resourcesMs: performance.now() - started };
  const initialListings = commandCount(record.commands, 'READDIR_ENTRIES:/folder');
  if (initialListings !== 1) throw new Error(`Expected one shared initial listing, received ${initialListings}`);
  const initial = { commands: { ...record.commands }, transport: snapshotTransport(record.transport) };
  const writer = new OpfsVfsWorker(config.name, {
    worker: runtime().worker,
    plugins: runtime().plugins(),
    bufferMode: 'memory',
  });
  await writer.ready;
  record.reset();
  try {
    await writer.writeFileBuffer('/unrelated', new Uint8Array([1]));
    await waitFor(() => dashboard.unrelated === 1, 'unrelated hook observation');
    const unrelatedContentReads = Object.entries(record.commands)
      .filter(([key]) => key.startsWith('READ_FILE_BUFFER:/content/'))
      .reduce((total, [, count]) => total + count, 0);
    if (unrelatedContentReads !== 0)
      throw new Error(`Unrelated update caused ${unrelatedContentReads} content reads for resolved resources`);
    let logicalWriteBytes = 0;
    const before = dashboard.replacements;
    for (let index = 1; index <= config.writes; index++) {
      const value = payload(config.contentSize, index);
      logicalWriteBytes += value.byteLength;
      await writer.writeFileBuffer('/content/0', value);
      if (index % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 4));
    }
    const stoppedAt = performance.now();
    await waitFor(() => dashboard.replacements > before && dashboard.latest === config.writes, 'SDK convergence');
    const convergenceMs = performance.now() - stoppedAt;
    const updates = { commands: { ...record.commands }, transport: snapshotTransport(record.transport) };
    record.reset();
    const previousBuffer = dashboard.current;
    if (!previousBuffer || !dashboard.resource0Refresh) throw new Error('SDK content refresh is unavailable');
    const equalRefreshStartedAt = performance.now();
    await dashboard.resource0Refresh();
    const equalRefreshMs = performance.now() - equalRefreshStartedAt;
    flushSync(() => root.render(view()));
    const equalRefresh = {
      phase: 'unchanged SDK refresh',
      ms: equalRefreshMs,
      sameBufferIdentity: dashboard.current === previousBuffer,
      commands: { ...record.commands },
      transport: snapshotTransport(record.transport),
    };
    if (!equalRefresh.sameBufferIdentity) throw new Error('Unchanged SDK refresh replaced the content buffer');
    const measurementEndedAt = performance.now();
    if (!window.__OPFS_VFS_BENCHMARK_CAPTURE_OVERLAP) throw new Error('Benchmark overlap heap capture is unavailable');
    await window.__OPFS_VFS_BENCHMARK_CAPTURE_OVERLAP();
    return {
      startup,
      convergenceMs,
      logical: { readBytes: config.resourceCount * config.contentSize, writeBytes: logicalWriteBytes },
      initial,
      commands: updates.commands,
      transport: updates.transport,
      equalRefresh,
      measurementEndedAt,
      assertions: {
        sharedInitialListing: initialListings,
        unrelatedContentReads,
        broadcastDeliveriesDeduplicated:
          updates.transport.broadcast.received.messages + updates.transport.broadcast.received.duplicates ===
          updates.transport.broadcast.received.deliveries,
        oldNewOverlapObserved: dashboard.marks.oldNewOverlapMs !== null,
      },
      marks: dashboard.marks,
    };
  } finally {
    await cleanup(
      () => retire(writer),
      async () => {
        try {
          await dashboard.close?.();
        } finally {
          root.unmount();
          element.remove();
          dashboard.previous = null;
          dashboard.current = null;
        }
      },
    );
  }
}

let tab:
  | { vfs: OpfsVfsWorker; subscription?: Subscription; root?: Root; element?: HTMLDivElement; latest: number }
  | undefined;
function TabView({ state }: { state: NonNullable<typeof tab> }) {
  const result = useFileContent('/live');
  if (result.status === 'success' && result.data instanceof Uint8Array) state.latest = result.data[0] ?? -1;
  return null;
}

window.reactSdkBenchmark = {
  async seed(config) {
    await seed(config);
  },
  async run(config) {
    const record = recorder();
    const { countedWorker, restore } = instrument(record);
    const observerEntries: PerformanceEntry[] = [];
    const observer = new PerformanceObserver((list) => observerEntries.push(...list.getEntries()));
    observer.observe({ type: 'longtask' });
    try {
      const workloadStartedAt = performance.now();
      const result =
        config.mode === 'direct'
          ? await direct(config, record, countedWorker)
          : await sdk(config, record, countedWorker);
      const workloadEndedAt = (result as { measurementEndedAt?: number }).measurementEndedAt ?? performance.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
      observerEntries.push(...observer.takeRecords());
      return {
        ...result,
        longTaskWindow: { startedAt: workloadStartedAt, endedAt: workloadEndedAt },
        workloadMs: workloadEndedAt - workloadStartedAt,
        longTasks: observerEntries
          .filter(
            (entry) => entry.startTime >= workloadStartedAt && entry.startTime + entry.duration <= workloadEndedAt,
          )
          .map((entry) => ({ startTime: entry.startTime, duration: entry.duration })),
      };
    } finally {
      observer.disconnect();
      restore();
      await deleteVolume(config.name);
    }
  },
  async openTab({ name, mode }) {
    if (tab) throw new Error('Tab already open');
    const vfs = new OpfsVfsWorker(name, {
      worker: runtime().worker,
      plugins: runtime().plugins(),
      bufferMode: 'memory',
    });
    await vfs.ready;
    tab = { vfs, latest: -1 };
    await vfs.writeFileBuffer('/live', new Uint8Array([0]));
    if (mode === 'direct') {
      tab.subscription = await subscribe(vfs, { path: '/live', scope: 'file', onError: () => {} }, () => {
        void vfs.readFileBuffer('/live').then((value) => (tab!.latest = value[0] ?? -1));
      });
    } else {
      tab.element = document.createElement('div');
      document.body.append(tab.element);
      tab.root = createRoot(tab.element);
      tab.root.render(
        <VolumeProvider client={vfs}>
          <TabView state={tab} />
        </VolumeProvider>,
      );
      await waitFor(() => tab!.latest === 0, 'SDK tab initial read');
    }
  },
  async writeTab(value) {
    if (!tab) throw new Error('Tab is not open');
    await tab.vfs.writeFileBuffer('/live', new Uint8Array([value]));
  },
  async waitTab(value) {
    await waitFor(() => tab?.latest === value, 'two-tab convergence');
  },
  async closeTab() {
    if (!tab) return;
    const current = tab;
    try {
      await retire(current.vfs, current.subscription);
    } finally {
      current.root?.unmount();
      current.element?.remove();
      tab = undefined;
    }
  },
  async deleteTabVolume(name) {
    await deleteVolume(name);
  },
};
