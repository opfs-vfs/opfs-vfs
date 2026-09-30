import type { ChangeFrame, FileChangeChannel, FileChangeSource, TerminalCode } from '@opfs-vfs/opfs-vfs/changes';
import type {
  FileChange,
  SubscribeLifecycle,
  SubscribeOptions,
  Subscription,
  SubscriptionError,
  SubscriptionRetirement,
  SubscriptionSetup,
} from './types';
import { abortError, error, validateOptions } from './validation';

type Local = {
  readonly id: string;
  readonly generation: string;
  readonly closed: Promise<SubscriptionRetirement>;
  readonly settle: (retirement: SubscriptionRetirement) => void;
  listener?: (change: FileChange) => void | Promise<void>;
  onError?: SubscribeOptions['onError'];
  state: 'preparing' | 'registering' | 'active' | 'retiring' | 'closed';
  resolved: boolean;
  settled: boolean;
  retiringNotified: boolean;
  cancelSent: boolean;
  terminalAcked: boolean;
  terminalCode?: TerminalCode;
  signal?: AbortSignal;
  abort?: () => void;
  failSetup?: (cause: unknown) => void;
  lifecycle?: SubscribeLifecycle;
};

type Context = {
  source: object;
  channel: FileChangeChannel;
  entries: Map<string, Local>;
  closed: boolean;
  opening: Opening;
};

type Opening = { promise: Promise<Context>; pending: number; context?: Context };
// Only the latest unknown setup cleanup matters: an older generation can no longer register.
type SetupRetirements = {
  pending: Map<Promise<SubscriptionRetirement>, string>;
  unknown: Map<string, SubscriptionError>;
  currentGeneration?: string;
};

const channels = new WeakMap<object, Opening>();
const setupRetirements = new WeakMap<object, SetupRetirements>();

function subscriptionError(code: TerminalCode, cause?: unknown): SubscriptionError {
  return Object.assign(new Error(code), cause === undefined ? { code } : { code, cause });
}

function report(onError: Local['onError'], code: TerminalCode): void {
  if (!onError) return;
  setTimeout(() => {
    try {
      Promise.resolve(onError(subscriptionError(code))).catch(() => {});
    } catch {
      // User error handlers cannot escape the library.
    }
  }, 0);
}

function cleanup(entry: Local): void {
  entry.listener = undefined;
  entry.onError = undefined;
  entry.signal?.removeEventListener('abort', entry.abort!);
  entry.signal = undefined;
  entry.abort = undefined;
}

function setupFor(source: object): SetupRetirements {
  let setup = setupRetirements.get(source);
  if (!setup) {
    setup = { pending: new Map(), unknown: new Map() };
    setupRetirements.set(source, setup);
  }
  return setup;
}

function open(source: FileChangeSource): Opening {
  const cached = channels.get(source as object);
  if (cached) return cached;
  let context: Context | undefined;
  let opening!: Opening;
  const promise = source
    .openFileChangeChannel(
      (frame) => {
        const entry = context?.entries.get(frame.subscriptionId);
        if (entry) handleFrame(context!, entry, frame);
      },
      (code) => {
        if (!context || context.closed) return;
        interrupt(context, code);
      },
      () => {
        if (!context || context.closed) return;
        context.closed = true;
        evict(context);
        for (const entry of [...context.entries.values()]) {
          if (!entry.resolved) trackSetup(context, entry);
          entry.failSetup?.(error('EBADF', 'Filesystem is closed'));
          entry.failSetup = undefined;
          settle(context, entry, { status: 'released' });
        }
      },
    )
    .then((channel) => {
      context = { source: source as object, channel, entries: new Map(), closed: false, opening };
      opening.context = context;
      closeIfUnused(context);
      return context;
    });
  opening = { promise, pending: 0 };
  channels.set(source as object, opening);
  void promise.catch(() => {
    if (channels.get(source as object) === opening) channels.delete(source as object);
  });
  return opening;
}

function evict(context: Context): void {
  if (channels.get(context.source) === context.opening) channels.delete(context.source);
}

function closeIfUnused(context: Context): void {
  if (context.entries.size || context.opening.pending || context.closed) return;
  context.closed = true;
  evict(context);
  context.channel.close();
}

function releasePending(opening: Opening): void {
  opening.pending--;
  if (opening.context) closeIfUnused(opening.context);
}

function settle(context: Context, entry: Local, retirement: SubscriptionRetirement): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.state = 'closed';
  notifyRetiring(entry);
  cleanup(entry);
  context.entries.delete(entry.id);
  entry.settle(retirement);
  closeIfUnused(context);
}

function setupOf(entry: Local): SubscriptionSetup {
  return { generation: entry.generation, closed: entry.closed };
}

function notifyRetiring(entry: Local): void {
  if (entry.retiringNotified) return;
  entry.retiringNotified = true;
  try {
    entry.lifecycle?.retiring?.(setupOf(entry));
  } catch {
    // Lifecycle observers cannot prevent local or remote cleanup.
  }
}

function releaseBeforeRegister(context: Context, entry: Local, cause: unknown): void {
  if (entry.state !== 'preparing') return;
  entry.failSetup?.(cause);
  entry.failSetup = undefined;
  settle(context, entry, { status: 'released' });
}

function interrupt(context: Context, code: TerminalCode = 'SUBSCRIPTION_INTERRUPTED', cause?: unknown): void {
  if (context.closed) return;
  context.closed = true;
  evict(context);
  for (const entry of context.entries.values()) {
    if (entry.state !== 'preparing') {
      entry.state = 'retiring';
      notifyRetiring(entry);
    }
  }
  try {
    context.channel.close();
  } catch {
    // The failed lane is already unusable.
  }
  for (const entry of [...context.entries.values()]) {
    const onError = entry.resolved ? entry.onError : undefined;
    if (!entry.resolved && entry.state !== 'preparing') trackSetup(context, entry);
    if (entry.state === 'preparing') {
      releaseBeforeRegister(context, entry, subscriptionError(code, cause));
      continue;
    }
    entry.failSetup?.(subscriptionError(code, cause));
    entry.failSetup = undefined;
    cleanup(entry);
    settle(context, entry, { status: 'unknown', error: subscriptionError(code, cause) });
    report(onError, code);
  }
}

function request(
  context: Context,
  entry: Local | undefined,
  command: Parameters<FileChangeChannel['request']>[0],
): void {
  if (context.closed) return;
  let pending: Promise<Awaited<ReturnType<FileChangeChannel['request']>>>;
  try {
    pending = context.channel.request(command);
  } catch (cause) {
    interrupt(context, 'SUBSCRIPTION_INTERRUPTED', cause);
    return;
  }
  void pending.then(
    () => {
      if (command.type === 'terminal-ack' && entry) settle(context, entry, { status: 'released' });
    },
    (cause) => interrupt(context, 'SUBSCRIPTION_INTERRUPTED', cause),
  );
}

function retire(context: Context, entry: Local): void {
  if (entry.state === 'closed' || entry.cancelSent || entry.terminalAcked) return;
  entry.state = 'retiring';
  entry.cancelSent = true;
  notifyRetiring(entry);
  cleanup(entry);
  request(context, undefined, { type: 'cancel', subscriptionId: entry.id });
}

function terminal(context: Context, entry: Local, code: TerminalCode): void {
  if (entry.state === 'closed') return;
  if (entry.state === 'preparing') {
    releaseBeforeRegister(context, entry, subscriptionError(code));
    return;
  }
  if (entry.terminalAcked) return;
  const onError = entry.resolved ? entry.onError : undefined;
  entry.terminalCode = code;
  if (!entry.resolved) trackSetup(context, entry);
  entry.state = 'retiring';
  entry.terminalAcked = true;
  notifyRetiring(entry);
  entry.failSetup?.(subscriptionError(code));
  entry.failSetup = undefined;
  cleanup(entry);
  request(context, entry, { type: 'terminal-ack', subscriptionId: entry.id });
  report(onError, code);
}

function handleFrame(context: Context, entry: Local, frame: ChangeFrame): void {
  if (frame.type === 'terminal') return terminal(context, entry, frame.code);
  if (frame.type === 'closed') {
    if (!entry.resolved && entry.state !== 'preparing') trackSetup(context, entry);
    if (entry.state === 'preparing') {
      releaseBeforeRegister(context, entry, error('EBADF', 'Filesystem is closed'));
      return;
    }
    if (entry.terminalAcked) return;
    entry.state = 'retiring';
    entry.terminalAcked = true;
    notifyRetiring(entry);
    entry.failSetup?.(error('EBADF', 'Filesystem is closed'));
    entry.failSetup = undefined;
    cleanup(entry);
    request(context, entry, { type: 'terminal-ack', subscriptionId: entry.id });
    return;
  }
  if (entry.state !== 'active') return;
  setTimeout(async () => {
    if (entry.state !== 'active' || !entry.listener) return;
    try {
      const listener = entry.listener;
      await listener(frame.change);
      if (entry.state === 'active')
        request(context, undefined, { type: 'ack', subscriptionId: entry.id, deliveryId: frame.deliveryId });
    } catch {
      if (entry.state !== 'active') return;
      const onError = entry.onError;
      retire(context, entry);
      report(onError, 'SUBSCRIPTION_CALLBACK_FAILED');
    }
  }, 0);
}

function awaitOpen(opening: Opening, signal?: AbortSignal): Promise<Context> {
  if (!signal) return opening.promise;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener('abort', abort);
      return true;
    };
    const abort = () => {
      if (finish()) reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    opening.promise.then(
      (context) => {
        if (finish()) resolve(context);
      },
      (cause) => {
        if (finish()) reject(cause);
      },
    );
  });
}

function awaitSetup(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener('abort', abort);
      return true;
    };
    const abort = () => {
      if (finish()) reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      () => {
        if (finish()) resolve();
      },
      (cause) => {
        if (finish()) reject(cause);
      },
    );
  });
}

async function waitForSetups(source: object, generation: string | undefined, signal?: AbortSignal): Promise<void> {
  const setup = setupFor(source);
  while (
    [...setup.pending.values()].some((entryGeneration) => generation === undefined || entryGeneration === generation)
  ) {
    const pending = [...setup.pending]
      .filter(([, entryGeneration]) => generation === undefined || entryGeneration === generation)
      .map(([closed]) => closed);
    if (!pending.length) return;
    await awaitSetup(
      Promise.all(pending).then(() => {}),
      signal,
    );
  }
}

function observeGeneration(setup: SetupRetirements, generation: string): void {
  if (setup.currentGeneration === generation) return;
  setup.currentGeneration = generation;
  setup.unknown.clear();
}

function trackSetup(context: Context, entry: Local): void {
  const setup = setupFor(context.source);
  if (setup.pending.has(entry.closed)) return;
  setup.pending.set(entry.closed, entry.generation);
  void entry.closed.then((retirement) => {
    setup.pending.delete(entry.closed);
    if (retirement.status === 'unknown' && setup.currentGeneration === entry.generation)
      setup.unknown.set(entry.generation, retirement.error);
  });
}

export async function subscribe(
  fs: FileChangeSource,
  options: SubscribeOptions,
  listener: (change: FileChange) => void | Promise<void>,
  lifecycle?: SubscribeLifecycle,
): Promise<Subscription> {
  const { wire, signal, onError } = validateOptions(options);
  if (typeof listener !== 'function') throw error('EINVAL', 'Listener must be a function');
  if (signal?.aborted) throw abortError();
  const source = fs as object;
  const opening = open(fs);
  opening.pending++;
  let context!: Context;
  let entry: Local | undefined;
  try {
    context = await awaitOpen(opening, signal);
    const setup = setupFor(source);
    observeGeneration(setup, context.channel.generation);
    if (lifecycle?.awaitSetupRetirements) {
      const hasPending = [...setup.pending.values()].some((generation) => generation === context.channel.generation);
      if (hasPending)
        await lifecycle.awaitSetupRetirements((waitSignal) =>
          waitForSetups(source, context.channel.generation, waitSignal),
        );
    } else {
      await waitForSetups(source, undefined, signal);
    }
    const previous = setup.unknown.get(context.channel.generation);
    if (previous)
      throw Object.assign(
        error(
          'SUBSCRIPTION_RETIREMENT_UNKNOWN',
          'An earlier subscription setup could not confirm owner cleanup; reopen the filesystem client',
        ),
        { cause: previous },
      );
    if (context.closed) throw error('EBADF', 'Filesystem is closed');
    if (signal?.aborted) throw abortError();
    const id = crypto.randomUUID();
    let resolveClosed!: (retirement: SubscriptionRetirement) => void;
    const closed = new Promise<SubscriptionRetirement>((resolve) => (resolveClosed = resolve));
    let failSetup!: (cause: unknown) => void;
    const setupTerminal = new Promise<never>((_, reject) => (failSetup = reject));
    const unsubscribe = () => {
      if (!entry) return;
      if (entry.state === 'preparing') {
        releaseBeforeRegister(context, entry, abortError());
        return;
      }
      const wasRegistering = entry.state === 'registering';
      if (wasRegistering) trackSetup(context, entry);
      retire(context, entry);
      if (wasRegistering) entry.failSetup?.(abortError());
    };
    entry = {
      id,
      generation: context.channel.generation,
      closed,
      settle: resolveClosed,
      listener,
      onError,
      state: 'preparing',
      resolved: false,
      settled: false,
      retiringNotified: false,
      cancelSent: false,
      signal,
      terminalAcked: false,
      failSetup,
      lifecycle,
    };
    void setupTerminal.catch(() => {});
    entry.abort = unsubscribe;
    signal?.addEventListener('abort', unsubscribe, { once: true });
    context.entries.set(id, entry);
    if (signal?.aborted || context.closed) {
      const cause = signal?.aborted ? abortError() : error('EBADF', 'Filesystem is closed');
      releaseBeforeRegister(context, entry, cause);
      throw cause;
    }
    try {
      lifecycle?.registering?.(setupOf(entry));
    } catch (cause) {
      releaseBeforeRegister(context, entry, cause);
      throw cause;
    }
    if (entry.state !== 'preparing' || signal?.aborted || context.closed) {
      const cause = signal?.aborted
        ? abortError()
        : entry.terminalCode
          ? subscriptionError(entry.terminalCode)
          : error('EBADF', 'Filesystem is closed');
      releaseBeforeRegister(context, entry, cause);
      throw cause;
    }
    entry.state = 'registering';
    let registration: Promise<Awaited<ReturnType<FileChangeChannel['request']>>>;
    try {
      registration = context.channel.request({ type: 'register', subscriptionId: id, options: wire });
    } catch (cause) {
      interrupt(context, 'SUBSCRIPTION_INTERRUPTED', cause);
      throw cause;
    }
    void registration.then(
      () => {},
      () => {
        // An owner or core admission rejection reserves nothing. Transport failures make core queue
        // interrupted() before this rejection is observed, which has already settled the entry unknown.
        if (!entry!.settled) {
          if (!entry!.resolved) trackSetup(context, entry!);
          settle(context, entry!, { status: 'released' });
        }
      },
    );
    let reply: Awaited<ReturnType<FileChangeChannel['request']>>;
    try {
      reply = await Promise.race([registration, setupTerminal]);
    } catch (cause) {
      if (!entry.terminalAcked) retire(context, entry);
      trackSetup(context, entry);
      throw cause;
    } finally {
      entry.failSetup = undefined;
    }
    if (reply.type !== 'registered' || reply.subscriptionId !== id) {
      retire(context, entry);
      trackSetup(context, entry);
      throw error('EINVAL', 'Invalid subscription reply');
    }
    if (entry.state !== 'registering' || signal?.aborted || context.closed) {
      if (!entry.terminalAcked) retire(context, entry);
      trackSetup(context, entry);
      throw signal?.aborted
        ? abortError()
        : entry.terminalCode
          ? subscriptionError(entry.terminalCode)
          : error('EBADF', 'Filesystem is closed');
    }
    entry.resolved = true;
    entry.state = 'active';
    const handle = Object.freeze({ unsubscribe, closed }) satisfies Subscription;
    setTimeout(() => {
      if (entry?.state === 'active') request(context, undefined, { type: 'activate', subscriptionId: id });
    }, 0);
    return handle;
  } finally {
    releasePending(opening);
  }
}

export type {
  ChangeType,
  FileChange,
  SubscribeOptions,
  Subscription,
  SubscriptionError,
  SubscriptionRetirement,
  SubscribeLifecycle,
  SubscriptionSetup,
} from './types';
