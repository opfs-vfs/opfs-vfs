import { OpenFlags, OpfsVfs } from '../opfs-vfs';
import { deleteVolume } from '../volume-files';
import type { ChangeFrame } from '../changes';
import { changesTransportPlugin } from './changes-transport-plugin';

const options = {
  path: '/',
  scope: 'directory' as const,
  recursive: true,
  events: ['create', 'update', 'delete'] as const,
  content: { maxBytes: 16 * 1024 * 1024 },
};

self.onmessage = async () => {
  const volume = `changes-transport-direct-${crypto.randomUUID()}.bin`;
  const vfs = new OpfsVfs(volume, { plugins: [changesTransportPlugin({})] });
  let result: { first: number[]; second: number[]; current: number[] } | { error: string } = {
    error: 'Direct transport worker did not finish',
  };
  try {
    await vfs.ready;
    const created = vfs.openSync('/direct', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.closeSync(created);
    const firstFrames: ChangeFrame[] = [];
    const secondFrames: ChangeFrame[] = [];
    const first = await vfs.openFileChangeChannel(
      (frame) => {
        if (frame.type === 'event' && frame.change.path === '/direct' && frame.change.content.status === 'included')
          frame.change.content.bytes.set([9]);
        firstFrames.push(frame);
      },
      () => {},
      () => {},
    );
    const second = await vfs.openFileChangeChannel(
      (frame) => secondFrames.push(frame),
      () => {},
      () => {},
    );
    for (const [channel, subscriptionId] of [
      [first, 'local-direct-ownership-probe-one'],
      [second, 'local-direct-ownership-probe-two'],
    ] as const) {
      await channel.request({ type: 'register', subscriptionId, options });
      await channel.request({ type: 'activate', subscriptionId });
    }
    const writer = vfs.openSync('/direct', OpenFlags.O_RDWR);
    vfs.writeSync(writer, new Uint8Array([1]));
    vfs.closeSync(writer);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const event = (frames: ChangeFrame[]) =>
      frames.find(
        (frame): frame is Extract<ChangeFrame, { type: 'event' }> =>
          frame.type === 'event' && frame.change.path === '/direct',
      );
    const one = event(firstFrames);
    const two = event(secondFrames);
    if (!one || !two || one.change.content.status !== 'included' || two.change.content.status !== 'included')
      throw new Error('Missing direct included deliveries');
    const probes = [
      '/.direct-ownership-probe-ok-local-direct-ownership-probe-one',
      '/.direct-ownership-probe-ok-local-direct-ownership-probe-two',
    ];
    const paths = [...firstFrames, ...secondFrames]
      .filter((frame) => frame.type === 'event')
      .map((frame) => frame.change.path);
    if (
      !probes.every((probe) => paths.includes(probe)) ||
      !paths.every((path) => path === '/direct' || probes.includes(path))
    )
      throw new Error('Direct borrowed capture was mutated');
    const reader = vfs.openSync('/direct', OpenFlags.O_RDONLY);
    const current = vfs.readSync(reader, 1, 0).buffer;
    vfs.closeSync(reader);
    result = {
      first: [...one.change.content.bytes],
      second: [...two.change.content.bytes],
      current: [...current],
    };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await vfs.closeVfs();
    } catch (error) {
      result = {
        error: `${'error' in result ? result.error : 'Direct transport completed'}; close failed: ${String(error)}`,
      };
    }
    try {
      await deleteVolume(volume);
    } catch (error) {
      result = {
        error: `${'error' in result ? result.error : 'Direct transport completed'}; delete failed: ${String(error)}`,
      };
    }
    self.postMessage(result);
  }
};
