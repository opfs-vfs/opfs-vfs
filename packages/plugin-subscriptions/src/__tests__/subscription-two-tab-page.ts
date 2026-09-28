import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { ChangeFrame, FileChangeChannel, FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscribe, type Subscription } from '../client';
import { subscriptionsRequest } from '../config';

declare global {
  interface Window {
    subscriptionLoad: {
      prepare(name: string): Promise<void>;
      hold(name: string): Promise<void>;
      releaseHeld(): void;
      rename(): Promise<void>;
      startStream(): Promise<void>;
      writeStream(): Promise<number>;
      startOwnerLocalStream(): Promise<void>;
      writeOwnerLocalStream(): Promise<number>;
      startFollowerProducerStream(): Promise<void>;
      writeFollowerProducerStream(): Promise<number>;
      disposeFollower(): void;
      disposeOwner(name: string): Promise<void>;
      metrics(): {
        first: number;
        second: number;
        streamed: number;
        ownerLocal: number;
        followerProducer: number;
        errors: string[];
        ackRttMs: number[];
        commandStartLagMs: number[];
      };
    };
  }
}

const worker = () => new Worker(new URL('./subscription-registration-worker.ts', import.meta.url), { type: 'module' });
let owner: OpfsVfsWorker | undefined;
let follower: OpfsVfsWorker | undefined;
let ownerSource: FileChangeSource | undefined;
let followerSource: FileChangeSource | undefined;
let roots: Subscription[] = [];
let stream: Subscription | undefined;
let first = 0;
let second = 0;
let streamed = 0;
let ownerLocal = 0;
let followerProducer = 0;
const errors: string[] = [];
let ownerLocalSubscription: Subscription | undefined;
let followerProducerSubscription: Subscription | undefined;
let releaseFirst!: () => void;
let releaseSecond!: () => void;
let holdFirst = true;
let holdSecond = true;

type Measurement = { ackRttMs: number[]; commandStartLagMs: number[] };
const ownerMeasurement: Measurement = { ackRttMs: [], commandStartLagMs: [] };
const followerMeasurement: Measurement = { ackRttMs: [], commandStartLagMs: [] };
const measured = (source: FileChangeSource, measurement: Measurement): FileChangeSource => ({
  openFileChangeChannel(receive, interrupted, closed) {
    return source.openFileChangeChannel(receive, interrupted, closed).then((channel) => ({
      generation: channel.generation,
      request(command) {
        const started = performance.now();
        return channel.request(command).then((reply) => {
          if (command.type === 'ack') measurement.ackRttMs.push(performance.now() - started);
          return reply;
        });
      },
      close() {
        channel.close();
      },
    })) as Promise<FileChangeChannel>;
  },
});
const observed = (change: Extract<ChangeFrame, { type: 'event' }>['change'], measurement: Measurement) => {
  const match = /\/(\d+(?:\.\d+)?)-\d+$/.exec(change.path);
  if (match) measurement.commandStartLagMs.push(performance.timeOrigin + performance.now() - Number(match[1]));
};
const commandPath = (parent: string, index: number) =>
  `${parent}/${performance.timeOrigin + performance.now()}-${index}`;

async function prepare(name: string): Promise<void> {
  owner = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
  await owner.ready;
  ownerSource = measured(owner, ownerMeasurement);
  await owner.mkdir('/source');
  await owner.mkdir('/stream');
  await owner.mkdir('/owner-local');
  await owner.mkdir('/follower-producer');
  for (let i = 0; i < 2047; i++) await owner.writeFileBuffer(`/source/${i}`, new Uint8Array([i & 255]));
}

async function hold(name: string): Promise<void> {
  follower = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
  await follower.ready;
  followerSource = measured(follower, followerMeasurement);
  const options = {
    path: '/',
    scope: 'directory' as const,
    recursive: true,
    onError: (cause: { code: string }) => errors.push(cause.code),
  };
  roots = [
    await subscribe(followerSource!, options, async (change) => {
      observed(change, followerMeasurement);
      first++;
      if (holdFirst) {
        holdFirst = false;
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      }
    }),
    await subscribe(followerSource!, options, async (change) => {
      observed(change, followerMeasurement);
      second++;
      if (holdSecond) {
        holdSecond = false;
        await new Promise<void>((resolve) => (releaseSecond = resolve));
      }
    }),
  ];
}

async function rename(): Promise<void> {
  await owner!.rename('/source', '/destination');
}

function releaseHeld(): void {
  releaseFirst();
  releaseSecond();
}

async function startStream(): Promise<void> {
  roots.forEach((subscription) => subscription.unsubscribe());
  stream = await subscribe(
    followerSource!,
    { path: '/stream', scope: 'directory', recursive: true, onError: (cause) => errors.push(cause.code) },
    (change) => {
      observed(change, followerMeasurement);
      streamed++;
    },
  );
}

async function writeStream(): Promise<number> {
  const started = performance.now();
  for (let i = 0; i < 10000; i++) await owner!.writeFileBuffer(commandPath('/stream', i), new Uint8Array([i & 255]));
  return performance.now() - started;
}

async function startOwnerLocalStream(): Promise<void> {
  ownerLocalSubscription = await subscribe(
    ownerSource!,
    { path: '/owner-local', scope: 'directory', recursive: true, onError: (cause) => errors.push(cause.code) },
    (change) => {
      observed(change, ownerMeasurement);
      ownerLocal++;
    },
  );
}

async function writeOwnerLocalStream(): Promise<number> {
  const started = performance.now();
  for (let i = 0; i < 10000; i++)
    await owner!.writeFileBuffer(commandPath('/owner-local', i), new Uint8Array([i & 255]));
  return performance.now() - started;
}

async function startFollowerProducerStream(): Promise<void> {
  followerProducerSubscription = await subscribe(
    followerSource!,
    { path: '/follower-producer', scope: 'directory', recursive: true, onError: (cause) => errors.push(cause.code) },
    (change) => {
      observed(change, followerMeasurement);
      followerProducer++;
    },
  );
}

async function writeFollowerProducerStream(): Promise<number> {
  const started = performance.now();
  for (let i = 0; i < 10000; i++)
    await follower!.writeFileBuffer(commandPath('/follower-producer', i), new Uint8Array([i & 255]));
  return performance.now() - started;
}

function disposeFollower(): void {
  stream?.unsubscribe();
  followerProducerSubscription?.unsubscribe();
  follower?.dispose();
}

async function disposeOwner(name: string): Promise<void> {
  ownerLocalSubscription?.unsubscribe();
  let failure: unknown;
  try {
    await owner?.closeVfs();
  } catch (error) {
    failure = error;
  } finally {
    owner?.dispose();
    try {
      await deleteVolume(name);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

Object.assign(window, {
  subscriptionLoad: {
    prepare,
    hold,
    releaseHeld,
    rename,
    startStream,
    writeStream,
    startOwnerLocalStream,
    writeOwnerLocalStream,
    startFollowerProducerStream,
    writeFollowerProducerStream,
    disposeFollower,
    disposeOwner,
    metrics: () => ({
      first,
      second,
      streamed,
      ownerLocal,
      followerProducer,
      errors,
      ackRttMs: [...followerMeasurement.ackRttMs, ...ownerMeasurement.ackRttMs],
      commandStartLagMs: [...followerMeasurement.commandStartLagMs, ...ownerMeasurement.commandStartLagMs],
    }),
  },
});
