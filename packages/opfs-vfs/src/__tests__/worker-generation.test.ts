import { expect, it, vi } from 'vitest';
import { GENERATION_METHODS, OpfsVfsWorker, VfsCommandError } from '../index_internal';

const name = () => `generation-${crypto.randomUUID()}.bin`;
const state = (client: OpfsVfsWorker) =>
  client as unknown as {
    worker: Worker | null;
    channel: BroadcastChannel;
    generation: string;
    leaderGeneration?: string;
  };

const profile = { version: 2, capabilities: ['error-details', 'persistence-status'], plugins: [] };

it('returns the narrow frozen generation client and validates its token', async () => {
  const client = new OpfsVfsWorker(name());
  try {
    await client.ready;
    const generation = client.getStatus().ownerGeneration!;
    const facade = client.forGeneration(generation);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual([...GENERATION_METHODS].sort());
    for (const invalid of ['', 'x'.repeat(129), null])
      expect(() => client.forGeneration(invalid as string)).toThrowError(expect.objectContaining({ code: 'EINVAL' }));
  } finally {
    await client.closeVfs();
  }
});

it('routes a captured generation through both leader and follower', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const leader = owner.forGeneration(owner.getStatus().ownerGeneration!);
    await leader.writeFileBuffer('/leader', new Uint8Array([1]));
    expect((await leader.readFileBuffer('/leader'))[0]).toBe(1);
    // Guards the role-aware first generation comparison.
    const relay = follower.forGeneration(follower.getStatus().ownerGeneration!);
    const post = vi.spyOn(state(follower).channel, 'postMessage');
    await relay.writeFileBuffer('/follower', new Uint8Array([2]));
    expect(post.mock.calls.find(([message]) => (message as { type?: string }).type === 'COMMAND')?.[0]).toMatchObject({
      generation: follower.getStatus().ownerGeneration,
    });
    post.mockRestore();
    expect((await relay.stat('/follower')).size).toBe(1);
    await relay.rename('/follower', '/renamed');
    expect((await relay.readdirEntries('/')).some((entry) => entry.name === 'renamed')).toBe(true);
    await relay.sync();
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('refuses every stale generation method before either transport posts', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const workerPost = vi.spyOn(state(owner).worker!, 'postMessage');
    const channelPost = vi.spyOn(state(follower).channel, 'postMessage');
    const stale = follower.forGeneration('stale-generation');
    const args: Record<(typeof GENERATION_METHODS)[number], unknown[]> = {
      readFileBuffer: ['/missing'],
      writeFileBuffer: ['/write', new Uint8Array()],
      stat: ['/missing'],
      lstat: ['/missing'],
      readdirEntries: ['/'],
      readlink: ['/missing'],
      realpath: ['/missing'],
      mkdir: ['/dir'],
      unlink: ['/missing'],
      rmdir: ['/missing'],
      remove: ['/missing'],
      rename: ['/old', '/new'],
      renameNoReplace: ['/old', '/new'],
      truncate: ['/missing', 0],
      chmod: ['/missing', 0o600],
      utimes: ['/missing', 0, 0],
      link: ['/old', '/new'],
      symlink: ['/old', '/new'],
      sync: [],
    };
    for (const method of GENERATION_METHODS) {
      const error = await (stale[method] as (...callArgs: unknown[]) => Promise<unknown>)(...args[method]).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(VfsCommandError);
      expect(error).toMatchObject({ dispatch: 'refused', details: { code: 'VFS_ATTACHMENT_LOST' } });
    }
    expect(workerPost).not.toHaveBeenCalled();
    expect(
      channelPost.mock.calls.filter(([message]) => (message as { type?: string }).type === 'COMMAND'),
    ).toHaveLength(0);
    workerPost.mockRestore();
    channelPost.mockRestore();
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('refuses stale facades when follower methods are own bound properties', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const privateFollower = follower as any;
    privateFollower.sync = follower.sync.bind(follower);
    privateFollower.writeFileBuffer = follower.writeFileBuffer.bind(follower);
    const post = vi.spyOn(state(follower).channel, 'postMessage');
    const stale = follower.forGeneration('stale-generation');
    await expect(stale.sync()).rejects.toMatchObject({ dispatch: 'refused' });
    await expect(stale.writeFileBuffer('/stale', new Uint8Array())).rejects.toMatchObject({ dispatch: 'refused' });
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'COMMAND')).toHaveLength(0);
    post.mockRestore();
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('keeps ordinary errors plain but marks validated owner errors as replied', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    await expect(owner.stat('/missing')).rejects.not.toBeInstanceOf(VfsCommandError);
    for (const client of [owner, follower]) {
      const error = await client
        .forGeneration(client.getStatus().ownerGeneration!)
        .stat('/missing')
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ dispatch: 'replied', details: { code: 'ENOENT', errno: 2 } });
    }
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('wraps synchronous transport failures as refused facade errors', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const workerPost = vi.spyOn(state(owner).worker!, 'postMessage').mockImplementation(() => {
      throw new DOMException('x', 'DataCloneError');
    });
    await expect(owner.forGeneration(owner.getStatus().ownerGeneration!).stat('/')).rejects.toMatchObject({
      dispatch: 'refused',
      details: { name: 'DataCloneError' },
    });
    workerPost.mockRestore();
    const channelPost = vi.spyOn(state(follower).channel, 'postMessage').mockImplementation(() => {
      throw new DOMException('x', 'DataCloneError');
    });
    await expect(follower.forGeneration(follower.getStatus().ownerGeneration!).stat('/')).rejects.toMatchObject({
      dispatch: 'refused',
      details: { name: 'DataCloneError' },
    });
    channelPost.mockRestore();
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('does not replay a sent facade write after routing is invalidated', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const channel = state(owner).channel;
    const post = channel.postMessage.bind(channel);
    let held!: () => void;
    const responseHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const hold = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
      if ((message as { type?: string }).type === 'RESPONSE') held();
      else post(message);
    });
    const workerPost = vi.spyOn(state(owner).worker!, 'postMessage');
    const old = follower.getStatus().ownerGeneration!;
    const write = follower
      .forGeneration(old)
      .writeFileBuffer('/once', new Uint8Array([1]))
      .catch((reason: unknown) => reason);
    await responseHeld;
    // Guards invalidateRouting rejection and the response-generation check.
    state(follower).channel.dispatchEvent(
      new MessageEvent('message', { data: { type: 'LEADER_READY', generation: 'replacement', profile } }),
    );
    expect(await write).toMatchObject({ dispatch: 'sent', details: { code: 'VFS_ATTACHMENT_LOST' } });
    expect(
      workerPost.mock.calls.filter(([message]) => (message as { type?: string }).type === 'WRITE_FILE_BUFFER'),
    ).toHaveLength(1);
    await expect(follower.forGeneration(old).sync()).rejects.toMatchObject({ dispatch: 'refused' });
    hold.mockRestore();
    workerPost.mockRestore();
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('records validated reply evidence only on the matching facade invocation', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  let attachment: OpfsVfsWorker | undefined;
  try {
    await Promise.all([owner.ready, follower.ready]);
    const channel = state(owner).channel;
    const post = channel.postMessage.bind(channel);
    const responses: any[] = [];
    const hold = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
      if ((message as { type?: string }).type === 'RESPONSE') responses.push(message);
      else post(message);
    });
    const followerPost = vi.spyOn(state(follower).channel, 'postMessage');
    const generation = follower.getStatus().ownerGeneration!;
    let firstSettled = false;
    const first = follower
      .forGeneration(generation)
      .writeFileBuffer('/first', new Uint8Array([1]))
      .catch((reason: unknown) => reason)
      .finally(() => {
        firstSettled = true;
      });
    const second = follower
      .forGeneration(generation)
      .writeFileBuffer('/second', new Uint8Array([2]))
      .catch((reason: unknown) => reason);
    await until(() => responses.length === 2);
    const firstCommand = followerPost.mock.calls.find(
      ([message]) => (message as { payload?: { payload?: { path?: string } } }).payload?.payload?.path === '/first',
    )![0] as { id: number };
    const firstId = firstCommand.id;
    const firstResponse = responses.find((message) => message.id === firstId)!;
    post({ ...firstResponse, type: 'RESPONSE_ERROR', result: { error: 'x', code: 'EIO' } });
    // The broadcast reply arrives in a later task; settle it before invalidating routing.
    await until(() => firstSettled);
    state(follower).channel.dispatchEvent(
      new MessageEvent('message', { data: { type: 'LEADER_READY', generation: 'replacement', profile } }),
    );
    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError).toMatchObject({ dispatch: 'replied', details: { code: 'EIO' } });
    expect(secondError).toMatchObject({ dispatch: 'sent', details: { code: 'VFS_ATTACHMENT_LOST' } });

    attachment = new OpfsVfsWorker(fileName);
    await attachment.ready;
    const write = attachment
      .forGeneration(attachment.getStatus().ownerGeneration!)
      .writeFileBuffer('/held', new Uint8Array([3]))
      .catch((reason: unknown) => reason);
    await until(() => responses.length === 3);
    const remoteError = (attachment as any).makeRemoteError({ error: 'gone', code: 'VFS_ATTACHMENT_LOST' });
    (attachment as any).disposeLocalResources(remoteError);
    expect(await write).toMatchObject({ dispatch: 'sent', details: { code: 'VFS_ATTACHMENT_LOST' } });
    followerPost.mockRestore();
    hold.mockRestore();
  } finally {
    attachment?.dispose();
    follower.dispose();
    await owner.closeVfs();
  }
});

async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Worker state did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Guards the role-aware first generation comparison for a new leader.
it('refuses a follower facade write paused before its own takeover', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const old = follower.getStatus().ownerGeneration!;
    const original = follower.ready;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    follower.ready = gate.then(() => original);
    const pending = follower
      .forGeneration(old)
      .writeFileBuffer('/late', new Uint8Array([1]))
      .catch((reason: unknown) => reason);
    await owner.closeVfs();
    await until(() => follower.getStatus().state === 'ready' && follower.getStatus().role === 'leader');
    expect(follower.getStatus().ownerGeneration).not.toBe(old);
    const post = vi.spyOn(state(follower).worker!, 'postMessage');
    release();
    const error = await pending;
    expect(error).toBeInstanceOf(VfsCommandError);
    expect(error).toMatchObject({ dispatch: 'refused', details: { code: 'VFS_ATTACHMENT_LOST' } });
    expect(
      post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'WRITE_FILE_BUFFER'),
    ).toHaveLength(0);
    post.mockRestore();
    expect(await follower.exists('/late')).toBe(false);
  } finally {
    follower.dispose();
    owner.dispose();
  }
});

// Guards the role-aware first generation comparison for a continuing follower.
it('refuses a follower facade write paused while another follower takes over', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const successor = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, successor.ready, follower.ready]);
    const old = follower.getStatus().ownerGeneration!;
    const original = follower.ready;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    follower.ready = gate.then(() => original);
    const pending = follower
      .forGeneration(old)
      .writeFileBuffer('/late', new Uint8Array([1]))
      .catch((reason: unknown) => reason);
    await owner.closeVfs();
    await until(() => successor.getStatus().state === 'ready' && successor.getStatus().role === 'leader');
    await until(
      () =>
        follower.getStatus().state === 'ready' &&
        follower.getStatus().role === 'follower' &&
        follower.getStatus().ownerGeneration !== old,
    );
    const post = vi.spyOn(state(follower).channel, 'postMessage');
    release();
    const error = await pending;
    expect(error).toBeInstanceOf(VfsCommandError);
    expect(error).toMatchObject({ dispatch: 'refused', details: { code: 'VFS_ATTACHMENT_LOST' } });
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'COMMAND')).toHaveLength(0);
    post.mockRestore();
    expect(await successor.exists('/late')).toBe(false);
  } finally {
    follower.dispose();
    successor.dispose();
    owner.dispose();
  }
});

// Guards the second generation comparison after awaiting workerReady.
it('refuses a leader facade command when its generation changes during worker readiness', async () => {
  const leader = new OpfsVfsWorker(name());
  const privateLeader = leader as any;
  try {
    await leader.ready;
    const generation = leader.getStatus().ownerGeneration!;
    const original = privateLeader.workerReady;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    privateLeader.workerReady = gate.then(() => original);
    const pending = leader
      .forGeneration(generation)
      .mkdir('/held')
      .catch((reason: unknown) => reason);
    // Let the command pass the first check and park at `await this.workerReady`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A real leader only changes generation through spawnWorker during takeover; isolate the second check here.
    privateLeader.generation = 'successor';
    const post = vi.spyOn(state(leader).worker!, 'postMessage');
    release();
    const error = await pending;
    expect(error).toBeInstanceOf(VfsCommandError);
    expect(error).toMatchObject({ dispatch: 'refused', details: { code: 'VFS_ATTACHMENT_LOST' } });
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'MKDIR')).toHaveLength(0);
    post.mockRestore();
    privateLeader.generation = generation;
  } finally {
    privateLeader.generation = leader.getStatus().ownerGeneration ?? privateLeader.generation;
    await leader.closeVfs();
  }
});

// Guards the leader COMMAND relay generation check.
it('refuses a forged command for a generation the leader does not own', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
  try {
    await owner.ready;
    const id = 1;
    const tabId = crypto.randomUUID();
    const response = new Promise<unknown>((resolve) => {
      channel.addEventListener('message', ({ data }) => {
        if (data?.id === id && data?.tabId === tabId && data?.type === 'RESPONSE_ERROR') resolve(data);
      });
    });
    channel.postMessage({
      id,
      type: 'COMMAND',
      generation: 'not-the-owner',
      clientId: crypto.randomUUID(),
      tabId,
      payload: { type: 'MKDIR', payload: { path: '/forged' } },
    });
    expect(await response).toMatchObject({ result: { code: 'VFS_ATTACHMENT_LOST' } });
    expect(await owner.exists('/forged')).toBe(false);
  } finally {
    channel.close();
    await owner.closeVfs();
  }
});

// Guards sent evidence after postMessage and pending rejection on worker failure.
it('marks a facade write as sent when its worker reply is lost before failure', async () => {
  const leader = new OpfsVfsWorker(name());
  try {
    await leader.ready;
    const worker = state(leader).worker!;
    const onmessage = worker.onmessage!;
    worker.onmessage = (event) => {
      if ((event.data as { type?: string }).type !== 'WRITE_FILE_BUFFER') onmessage.call(worker, event);
    };
    const post = vi.spyOn(worker, 'postMessage');
    const write = leader
      .forGeneration(leader.getStatus().ownerGeneration!)
      .writeFileBuffer('/lost', new Uint8Array([1]));
    await until(() => post.mock.calls.some(([message]) => (message as { type?: string }).type === 'WRITE_FILE_BUFFER'));
    (leader as any).failWorker('test failure', new Error('x'));
    await expect(write).rejects.toMatchObject({ dispatch: 'sent', details: { code: 'VFS_WORKER_FAILED' } });
    post.mockRestore();
  } finally {
    leader.dispose();
  }
});

// Guards dispatch evidence stored per facade invocation rather than on a shared rejection.
it('keeps sent and refused evidence separate when routing invalidates two facade writes', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const post = state(owner).channel.postMessage.bind(state(owner).channel);
    let responseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      responseHeld = resolve;
    });
    const hold = vi.spyOn(state(owner).channel, 'postMessage').mockImplementation((message) => {
      if ((message as { type?: string }).type === 'RESPONSE') responseHeld();
      else post(message);
    });
    const old = follower.getStatus().ownerGeneration!;
    const first = follower
      .forGeneration(old)
      .writeFileBuffer('/first', new Uint8Array([1]))
      .catch((reason: unknown) => reason);
    await held;
    const original = follower.ready;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    follower.ready = gate.then(() => original);
    const second = follower
      .forGeneration(old)
      .writeFileBuffer('/second', new Uint8Array([2]))
      .catch((reason: unknown) => reason);
    state(follower).channel.dispatchEvent(
      new MessageEvent('message', { data: { type: 'LEADER_READY', generation: 'replacement', profile } }),
    );
    await until(() => follower.getStatus().ownerGeneration === 'replacement');
    release();
    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError).toMatchObject({ dispatch: 'sent', details: { code: 'VFS_ATTACHMENT_LOST' } });
    expect(secondError).toMatchObject({ dispatch: 'refused', details: { code: 'VFS_ATTACHMENT_LOST' } });
    expect(firstError).not.toBe(secondError);
    expect((firstError as Error & { cause?: unknown }).cause).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
    hold.mockRestore();
  } finally {
    follower.dispose();
    owner.dispose();
  }
});

// Guards response generation validation in sendToLeader.
it('refuses a response from a different leader generation', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const post = state(owner).channel.postMessage.bind(state(owner).channel);
    const rewrite = vi.spyOn(state(owner).channel, 'postMessage').mockImplementation((message) => {
      post((message as { type?: string }).type === 'RESPONSE' ? { ...message, generation: 'other' } : message);
    });
    await expect(follower.forGeneration(follower.getStatus().ownerGeneration!).stat('/')).rejects.toMatchObject({
      dispatch: 'sent',
      details: { code: 'VFS_ATTACHMENT_LOST' },
    });
    rewrite.mockRestore();
  } finally {
    follower.dispose();
    owner.dispose();
  }
});
