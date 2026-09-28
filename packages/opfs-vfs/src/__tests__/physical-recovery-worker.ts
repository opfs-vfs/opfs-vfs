import { deleteVolume } from '../index';
import { OpenFlags, OpfsVfs } from '../opfs-vfs';

const BLOCK = 4096;
const options = { bufferMode: 'disk', localDurabilityMode: 'relaxed', noatime: true } as const;

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function write(vfs: OpfsVfs, path: string, data: Uint8Array, at = 0) {
  const fd = vfs.openSync(path, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  try {
    check(vfs.writeSync(fd, data, at) === data.length, `write ${path}`);
  } finally {
    vfs.closeSync(fd);
  }
  vfs.syncSync();
}

function expectFile(vfs: OpfsVfs, path: string, expected: Uint8Array) {
  check(vfs.statSync(path).size === expected.length, `${path}: size must be ${expected.length}`);
  const fd = vfs.openSync(path);
  try {
    const actual = vfs.readSync(fd, expected.length + 1);
    check(actual.read === expected.length, `${path}: exact read length`);
    check(
      actual.buffer.every((byte, i) => byte === expected[i]),
      `${path}: exact surviving bytes`,
    );
    check(vfs.readSync(fd, 1, expected.length).read === 0, `${path}: EOF`);
  } finally {
    vfs.closeSync(fd);
  }
}

self.onmessage = async ({ data: { layout, cut, expectedSize } }) => {
  const name = `physical-recovery-${crypto.randomUUID()}.bin`;
  const content = Uint8Array.from({ length: 2 * BLOCK + 7 }, (_, i) => (i * 31 + 17) % 251);
  const guard = new Uint8Array(BLOCK).fill(93);
  let mounted: OpfsVfs | undefined;
  let result: { ok: true } | { error: string };
  try {
    const root = await navigator.storage.getDirectory();
    mounted = new OpfsVfs(name, options);
    await mounted.ready;
    write(mounted, '/guard', guard); // Physical block 1 survives every cut below.
    await mounted.closeVfs();
    mounted = undefined;
    mounted = new OpfsVfs(name, options);
    await mounted.ready;
    write(mounted, '/hole', guard); // Block 2.
    write(mounted, '/file', content.subarray(0, BLOCK)); // Block 3.
    write(mounted, '/scratch', guard); // Block 4.
    if (layout === 'middle') {
      write(mounted, '/file', content.subarray(BLOCK, 2 * BLOCK), BLOCK); // Block 5.
      mounted.unlinkSync('/hole');
      mounted.syncSync();
    } else {
      mounted.unlinkSync('/hole');
      mounted.syncSync();
      write(mounted, '/file', content.subarray(BLOCK, 2 * BLOCK), BLOCK); // Reuse block 2.
      mounted.unlinkSync('/scratch');
      mounted.syncSync();
    }
    write(mounted, '/file', content.subarray(2 * BLOCK), 2 * BLOCK);
    const blocks = (mounted as unknown as { inodes: Map<string, { blocks: number[] }> }).inodes.get('/file')!.blocks;
    const mapping = layout === 'middle' ? [3, 5, 2] : [3, 2, 4];
    check(
      JSON.stringify(blocks) === JSON.stringify(mapping),
      `fixture must map ${String(mapping)}, got ${String(blocks)}`,
    );
    expectFile(mounted, '/file', content);
    await mounted.closeVfs();
    mounted = undefined;

    const dataFile = await root.getFileHandle(name);
    const stream = await dataFile.createWritable({ keepExistingData: true });
    await stream.truncate(cut);
    await stream.close();
    check((await dataFile.getFile()).size === cut, 'physical truncation must actually happen');

    for (let reopen = 0; reopen < 2; reopen++) {
      mounted = new OpfsVfs(name, options);
      await mounted.ready;
      expectFile(mounted, '/file', content.subarray(0, expectedSize));
      expectFile(mounted, '/guard', guard);
      await mounted.closeVfs();
      mounted = undefined;
    }
    result = { ok: true };
  } catch (error) {
    result = { error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) };
  } finally {
    try {
      await mounted?.closeVfs();
      await deleteVolume(name);
    } catch (error) {
      result = { error: `cleanup failed: ${String(error)}` };
    }
  }
  self.postMessage(result!);
};
