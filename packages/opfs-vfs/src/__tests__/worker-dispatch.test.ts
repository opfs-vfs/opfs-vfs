import { expect, it, vi } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';

const name = () => `dispatch-${crypto.randomUUID()}.bin`;
const state = (client: OpfsVfsWorker) => client as unknown as { worker: Worker | null; channel: BroadcastChannel };

it('sets evidence only after a successful worker or channel post', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const sentRecord = { sent: false };
    await (owner as any).sendToWorker('STAT', { path: '/' }, undefined, undefined, sentRecord);
    expect(sentRecord.sent).toBe(true);
    const workerRecord = { sent: false };
    const workerPost = vi.spyOn(state(owner).worker!, 'postMessage').mockImplementation(() => {
      throw new DOMException('x', 'DataCloneError');
    });
    await expect(
      (owner as any).sendToWorker('STAT', { path: '/' }, undefined, undefined, workerRecord),
    ).rejects.toThrow('x');
    expect(workerRecord.sent).toBe(false);
    workerPost.mockRestore();

    const channelRecord = { sent: false };
    const channelPost = vi.spyOn(state(follower).channel, 'postMessage').mockImplementation(() => {
      throw new DOMException('x', 'DataCloneError');
    });
    await expect(
      (follower as any).sendToWorker('STAT', { path: '/' }, undefined, undefined, channelRecord),
    ).rejects.toThrow('x');
    expect(channelRecord.sent).toBe(false);
    channelPost.mockRestore();
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});
