import { expect, it } from 'vitest';

const env = (import.meta as unknown as { env?: Record<string, string> }).env;
const legacyPrefix = env?.VITE_MIXED_LEGACY;
const candidatePrefix = env?.VITE_MIXED_CANDIDATE;
if (!legacyPrefix?.startsWith('/.packed/') || !candidatePrefix?.startsWith('/.packed/'))
  throw new Error('Mixed-build artifact paths are required');

type Client = {
  ready: Promise<void>;
  disposed: boolean;
  getStatus?(): {
    state: string;
    role: string | null;
    error: { code?: string } | null;
    persistence?: { state: string; failureRevision: number } | null;
    ownerGeneration?: string | null;
  };
  subscribeStatus?(listener: () => void): () => void;
  closeVfs(): Promise<void>;
  dispose(): void;
  writeFileBuffer(path: string, data: Uint8Array): Promise<void>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  mkdir(path: string): Promise<void>;
};
type Side = {
  OpfsVfsWorker: new (fileName: string, options?: Record<string, unknown>) => Client;
  deleteVolume(fileName: string): Promise<void>;
  subscriptionsRequest(): unknown;
  workerFactory: () => Worker;
  plainWorkerFactory: () => Worker;
};
// Each side resolves only its own installed artifacts under .packed/<side>/node_modules.
const load = async (prefix: string): Promise<Side> => ({
  ...(await import(/* @vite-ignore */ `${prefix}client.ts`)),
  ...(await import(/* @vite-ignore */ `${prefix}factories.ts`)),
});
const [legacy, candidate] = await Promise.all([load(legacyPrefix), load(candidatePrefix)]);
const name = () => `mixed-${crypto.randomUUID()}.bin`;
const options = { initTimeout: 15_000 };
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected mixed-build status to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const rejectBeforeTimeout = async (client: Client, started: number, code: string) => {
  await expect(client.ready).rejects.toMatchObject({ code });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(client.disposed).toBe(true);
  if (code === 'VFS_PROTOCOL_MISMATCH')
    expect(client.getStatus?.()).toMatchObject({ state: 'failed', error: { code } });
};
const close = async (...clients: Client[]) => {
  for (const client of [...clients].reverse()) {
    try {
      await client.closeVfs();
    } catch {
      // A rejected or already-disposed client has nothing left to close.
    }
    client.dispose();
  }
};
const verify = async (client: Client, path = '/file') => {
  await client.writeFileBuffer(path, new Uint8Array([42]));
  expect(await client.readFileBuffer(path)).toEqual(new Uint8Array([42]));
};

it('refuses a candidate follower of a legacy bundled owner', async () => {
  const fileName = name();
  const owner = new legacy.OpfsVfsWorker(fileName, options);
  let follower: Client | undefined;
  try {
    await owner.ready;
    const started = Date.now();
    follower = new candidate.OpfsVfsWorker(fileName, options);
    await rejectBeforeTimeout(follower, started, 'VFS_PROTOCOL_MISMATCH');
    await verify(owner);
  } finally {
    await close(...([owner, follower].filter(Boolean) as Client[]));
    await legacy.deleteVolume(fileName);
  }
});

it('refuses a legacy follower of a candidate bundled owner', async () => {
  const fileName = name();
  const owner = new candidate.OpfsVfsWorker(fileName, options);
  let follower: Client | undefined;
  try {
    await owner.ready;
    await until(() => !!owner.getStatus?.().persistence);
    const started = Date.now();
    follower = new legacy.OpfsVfsWorker(fileName, options);
    await rejectBeforeTimeout(follower, started, 'VFS_PLUGIN_MISMATCH');
    expect(owner.getStatus?.()).toMatchObject({ state: 'ready', role: 'leader', persistence: expect.any(Object) });
    await verify(owner);
    expect(owner.getStatus?.()).toMatchObject({ persistence: expect.any(Object) });
  } finally {
    await close(...([owner, follower].filter(Boolean) as Client[]));
    await candidate.deleteVolume(fileName);
  }
});

it('refuses a candidate subscriptions follower of a legacy owner', async () => {
  const fileName = name();
  const owner = new legacy.OpfsVfsWorker(fileName, {
    ...options,
    worker: legacy.workerFactory,
    plugins: [legacy.subscriptionsRequest()],
  });
  let follower: Client | undefined;
  try {
    await owner.ready;
    const started = Date.now();
    follower = new candidate.OpfsVfsWorker(fileName, {
      ...options,
      worker: candidate.workerFactory,
      plugins: [candidate.subscriptionsRequest()],
    });
    await rejectBeforeTimeout(follower, started, 'VFS_PROTOCOL_MISMATCH');
    await verify(owner);
  } finally {
    await close(...([owner, follower].filter(Boolean) as Client[]));
    await legacy.deleteVolume(fileName);
  }
});

it('refuses a legacy subscriptions follower of a candidate owner', async () => {
  const fileName = name();
  const owner = new candidate.OpfsVfsWorker(fileName, {
    ...options,
    worker: candidate.workerFactory,
    plugins: [candidate.subscriptionsRequest()],
  });
  let follower: Client | undefined;
  try {
    await owner.ready;
    await until(() => !!owner.getStatus?.().persistence);
    const started = Date.now();
    follower = new legacy.OpfsVfsWorker(fileName, {
      ...options,
      worker: legacy.workerFactory,
      plugins: [legacy.subscriptionsRequest()],
    });
    await rejectBeforeTimeout(follower, started, 'VFS_PLUGIN_MISMATCH');
    expect(owner.getStatus?.()).toMatchObject({ state: 'ready', role: 'leader', persistence: expect.any(Object) });
    await verify(owner);
    expect(owner.getStatus?.()).toMatchObject({ persistence: expect.any(Object) });
  } finally {
    await close(...([owner, follower].filter(Boolean) as Client[]));
    await candidate.deleteVolume(fileName);
  }
});

it('refuses cached page and worker bundles from different builds', async () => {
  const candidateName = name();
  const legacyName = name();
  const candidateStarted = Date.now();
  const candidateClient = new candidate.OpfsVfsWorker(candidateName, {
    ...options,
    worker: legacy.plainWorkerFactory,
  });
  const legacyStarted = Date.now();
  const legacyClient = new legacy.OpfsVfsWorker(legacyName, {
    ...options,
    worker: candidate.plainWorkerFactory,
  });
  try {
    await rejectBeforeTimeout(candidateClient, candidateStarted, 'VFS_PROTOCOL_MISMATCH');
    expect(candidateClient.getStatus?.()).toMatchObject({ persistence: null });
    await rejectBeforeTimeout(legacyClient, legacyStarted, 'VFS_PLUGIN_MISMATCH');
  } finally {
    await close(candidateClient, legacyClient);
    await Promise.all([candidate.deleteVolume(candidateName), legacy.deleteVolume(legacyName)]);
  }
});

it('keeps sequential ownership compatible while refusing a live legacy owner', async () => {
  const fileName = name();
  const candidateOwner = new candidate.OpfsVfsWorker(fileName, options);
  let legacyOwner: Client | undefined;
  let refused: Client | undefined;
  let nextCandidate: Client | undefined;
  try {
    await candidateOwner.ready;
    await candidateOwner.writeFileBuffer('/from-candidate', new Uint8Array([1]));
    await close(candidateOwner);

    legacyOwner = new legacy.OpfsVfsWorker(fileName, options);
    await legacyOwner.ready;
    expect(await legacyOwner.readFileBuffer('/from-candidate')).toEqual(new Uint8Array([1]));
    await legacyOwner.writeFileBuffer('/from-legacy', new Uint8Array([2]));
    const started = Date.now();
    refused = new candidate.OpfsVfsWorker(fileName, options);
    await rejectBeforeTimeout(refused, started, 'VFS_PROTOCOL_MISMATCH');
    await close(legacyOwner);
    legacyOwner = undefined;

    nextCandidate = new candidate.OpfsVfsWorker(fileName, options);
    await nextCandidate.ready;
    await until(() => !!nextCandidate?.getStatus?.().persistence);
    expect(await nextCandidate.readFileBuffer('/from-legacy')).toEqual(new Uint8Array([2]));
  } finally {
    await close(...([candidateOwner, legacyOwner, refused, nextCandidate].filter(Boolean) as Client[]));
    await candidate.deleteVolume(fileName);
  }
});

it('refuses a legacy page without disturbing a ready candidate follower', async () => {
  const fileName = name();
  const owner = new candidate.OpfsVfsWorker(fileName, options);
  let follower: Client | undefined;
  let legacyClient: Client | undefined;
  try {
    await owner.ready;
    follower = new candidate.OpfsVfsWorker(fileName, options);
    await follower.ready;
    await until(
      () =>
        !!follower?.getStatus?.().persistence &&
        follower?.getStatus?.().ownerGeneration === owner.getStatus?.().ownerGeneration,
    );
    const started = Date.now();
    legacyClient = new legacy.OpfsVfsWorker(fileName, options);
    await rejectBeforeTimeout(legacyClient, started, 'VFS_PLUGIN_MISMATCH');
    const seen: string[] = [];
    const unsubscribe = follower.subscribeStatus?.(() =>
      seen.push(follower!.getStatus?.().persistence?.state ?? 'null'),
    );
    await follower.writeFileBuffer('/through-follower', new Uint8Array([3]));
    expect(await owner.readFileBuffer('/through-follower')).toEqual(new Uint8Array([3]));
    await until(() => seen.includes('dirty') && follower?.getStatus?.().persistence?.state === 'clean');
    unsubscribe?.();
  } finally {
    await close(...([owner, follower, legacyClient].filter(Boolean) as Client[]));
    await candidate.deleteVolume(fileName);
  }
});
