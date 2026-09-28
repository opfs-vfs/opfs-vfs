import { deleteVolume, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import type { ChangeCommand, ChangeReply, FileChangeChannel, FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import { subscribe } from '../client';
import { subscriptions } from '../owner';

const options = {
  path: '/',
  scope: 'directory' as const,
  recursive: true,
  events: ['create', 'update', 'delete'] as const,
  content: false as const,
  onError() {},
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settled = <T>(promise: Promise<T>) => Promise.race([promise, flush().then(() => 'pending' as const)]);
type HeldCommand = {
  command: ChangeCommand;
  resolve: (reply: ChangeReply) => void;
  reject: (cause: unknown) => void;
  channel: FileChangeChannel;
};

self.onmessage = async () => {
  const name = `subscription-retirement-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfs(name, { plugins: [subscriptions()] });
  let closed = false;
  let result: object;
  try {
    await fs.ready;
    let holding = true;
    let held: HeldCommand[] = [];
    const source: FileChangeSource = {
      openFileChangeChannel(receive, interrupted, closedCallback) {
        return fs.openFileChangeChannel(receive, interrupted, closedCallback).then((channel) => ({
          generation: channel.generation,
          request(command) {
            if (holding && command.type === 'terminal-ack')
              return new Promise<ChangeReply>((resolve, reject) => held.push({ command, resolve, reject, channel }));
            return channel.request(command);
          },
          close() {
            channel.close();
          },
        }));
      },
    };
    const rejected = await Promise.all(
      Array.from({ length: 40 }, () =>
        subscribe(source, { ...options, scope: 'file' as const, recursive: false }, () => {}).then(
          () => 'UNEXPECTED_SUCCESS',
          (error) => (error as { code: string }).code,
        ),
      ),
    );
    const first = await Promise.all(Array.from({ length: 32 }, () => subscribe(source, options, () => {})));
    first.forEach((handle) => handle.unsubscribe());
    await flush();
    const retirement = await Promise.all(first.map((handle) => settled(handle.closed)));
    const pending = retirement.every((value) => value === 'pending');
    let overflow: string | undefined;
    try {
      await subscribe(source, options, () => {});
    } catch (error) {
      overflow = (error as { code?: string }).code;
    }
    holding = false;
    for (const item of held) item.channel.request(item.command).then(item.resolve, item.reject);
    held = [];
    const released = await Promise.all(first.map((handle) => handle.closed));
    const second = await Promise.all(Array.from({ length: 32 }, () => subscribe(source, options, () => {})));
    const active = second[31]!;
    for (const handle of second.slice(0, 31)) handle.unsubscribe();
    await Promise.all(second.slice(0, 31).map((handle) => handle.closed));
    await fs.closeVfs();
    closed = true;
    const close = await active.closed;
    result = { pending, rejected, overflow, released, close };
  } catch (error) {
    result = { error: error instanceof Error ? `${error.name}:${error.message}` : String(error) };
  } finally {
    if (!closed) await Promise.resolve(fs.closeVfs()).catch(() => {});
    await deleteVolume(name).catch(() => {});
    self.postMessage(result!);
  }
};
