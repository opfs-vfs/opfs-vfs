// §6.5 — cross-worker behavioral parity. SAB-4 (Phase 3) showed same-worker
// (OpfsVfs, direct calls) and cross-worker (OpfsVfsWorker, SAB bridge) modes
// diverged on errno semantics. This worker runs ONE assertion function over
// BOTH transports and reports the captured errno/value for each scenario; the
// test asserts they are identical.
import { OpfsVfsWorker } from '../index_internal';
import { OpenFlags, OpfsVfs } from '../opfs-vfs';

const origError = console.error;
const formatError = (error: unknown) =>
  `${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? (error.stack ?? '') : ''}`;
console.error = (...args: unknown[]) => {
  origError(...args);
  try {
    self.postMessage({ type: 'LOG', msg: `[ERROR] ${args.map((a) => String(a)).join(' ')}` });
  } catch {}
};

// The common synchronous surface exercised by the parity assertions. Both
// OpfsVfs and OpfsVfsWorker implement these with identical signatures.
interface SyncVfs {
  mkdirSync(path: string, mode?: number): void;
  openSync(path: string, flags: number, mode?: number): number;
  writeSync(fd: number, data: Uint8Array, offset?: number): number;
  readSync(fd: number, size: number, offset?: number): { buffer: Uint8Array; read: number };
  seekSync(fd: number, offset: number, whence: number): number;
  closeSync(fd: number): void;
  truncateSync(path: string, size: number): void;
  unlinkSync(path: string): void;
  rmdirSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
}

type Outcome = { name: string; value: string };

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : `<no-code:${error instanceof Error ? error.message : String(error)}>`;
}

// Capture the errno (or value) of each POSIX-semantics scenario. Every path is
// prefixed per-transport so the two runs never collide on shared OPFS state.
function runAssertions(vfs: SyncVfs, root: string): Outcome[] {
  const out: Outcome[] = [];
  const expectThrow = (name: string, fn: () => void) => {
    try {
      fn();
      out.push({ name, value: '<no-error-thrown>' });
    } catch (error) {
      out.push({ name, value: codeOf(error) });
    }
  };

  // ENOENT: open a missing file without O_CREAT.
  expectThrow('ENOENT open missing', () => vfs.openSync(`${root}/missing.txt`, OpenFlags.O_RDONLY));

  // EEXIST: O_CREAT|O_EXCL on an existing file.
  const fdExcl = vfs.openSync(`${root}/excl.txt`, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  vfs.closeSync(fdExcl);
  expectThrow('EEXIST O_CREAT|O_EXCL', () =>
    vfs.openSync(`${root}/excl.txt`, OpenFlags.O_CREAT | OpenFlags.O_EXCL | OpenFlags.O_RDWR),
  );

  // EBADF: read from a closed fd.
  const fdClosed = vfs.openSync(`${root}/closed.txt`, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  vfs.closeSync(fdClosed);
  expectThrow('EBADF read closed fd', () => vfs.readSync(fdClosed, 8, 0));

  // ENOTDIR: rmdir on a regular file.
  const fdFile = vfs.openSync(`${root}/regular.txt`, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  vfs.closeSync(fdFile);
  expectThrow('ENOTDIR rmdir on file', () => vfs.rmdirSync(`${root}/regular.txt`));

  // EISDIR: unlink on a directory.
  vfs.mkdirSync(`${root}/adir`);
  expectThrow('EISDIR unlink on dir', () => vfs.unlinkSync(`${root}/adir`));

  // ENOTEMPTY: rmdir on a non-empty directory.
  vfs.mkdirSync(`${root}/nonempty`);
  const fdChild = vfs.openSync(`${root}/nonempty/child.txt`, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  vfs.closeSync(fdChild);
  expectThrow('ENOTEMPTY rmdir non-empty', () => vfs.rmdirSync(`${root}/nonempty`));

  // EISDIR/ENOTEMPTY rename: rename a file over a non-empty directory.
  const fdSrc = vfs.openSync(`${root}/src.txt`, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  vfs.closeSync(fdSrc);
  expectThrow('rename file over non-empty dir', () => vfs.renameSync(`${root}/src.txt`, `${root}/nonempty`));

  // EACCES: truncate a read-only (0o444) file.
  const fdRo = vfs.openSync(`${root}/ro.txt`, OpenFlags.O_CREAT | OpenFlags.O_RDWR, 0o444);
  vfs.closeSync(fdRo);
  expectThrow('EACCES truncate read-only file', () => vfs.truncateSync(`${root}/ro.txt`, 0));

  // Happy-path read/write/seek round-trip — capture the observable values.
  const fd = vfs.openSync(`${root}/rw.txt`, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const wrote = vfs.writeSync(fd, payload, 0);
  out.push({ name: 'write count', value: String(wrote) });
  const seeked = vfs.seekSync(fd, 2, 0); // SEEK_SET to offset 2
  out.push({ name: 'seek position', value: String(seeked) });
  const r = vfs.readSync(fd, 3); // implicit cursor at 2 -> bytes [3,4,5]
  out.push({ name: 'read count', value: String(r.read) });
  out.push({ name: 'read bytes', value: Array.from(r.buffer.subarray(0, r.read)).join(',') });
  vfs.closeSync(fd);

  return out;
}

self.onmessage = async (event: MessageEvent) => {
  const { type } = event.data;
  if (type !== 'RUN_PARITY_MATRIX_TEST') return;

  let same: OpfsVfs | null = null;
  let cross: OpfsVfsWorker | null = null;
  try {
    const uid = Math.random().toString(36).slice(2);

    // Same-worker transport (direct OpfsVfs).
    same = new OpfsVfs(`parity-same-${uid}.bin`);
    await same.ready;
    same.mkdirSync('/same');
    const sameOutcomes = runAssertions(same as unknown as SyncVfs, '/same');

    // Cross-worker transport (OpfsVfsWorker sync API over the SAB bridge).
    // Legacy JS callers may still pass the removed blockingSab option. It must
    // no longer starve async requests or shutdown after synchronous work.
    cross = new OpfsVfsWorker(`parity-cross-${uid}.bin`, { forceLeader: true, ...{ blockingSab: true } });
    await cross.ready;
    cross.mkdirSync('/cross');
    const crossOutcomes = runAssertions(cross as unknown as SyncVfs, '/cross');

    // Compare per scenario.
    const results: { check: string; pass: boolean; detail?: string }[] = [];
    for (let i = 0; i < sameOutcomes.length; i++) {
      const s = sameOutcomes[i];
      const c = crossOutcomes[i];
      results.push({
        check: `parity: ${s.name}`,
        pass: s.value === c.value,
        detail: `same=${s.value} cross=${c.value}`,
      });
    }

    results.push({ check: 'async stat after sync work', pass: (await cross.stat('/cross/rw.txt')).size === 8 });
    await cross.closeVfs();
    cross = new OpfsVfsWorker(`parity-cross-${uid}.bin`, { forceLeader: true });
    await cross.ready;
    results.push({ check: 'remount after mixed sync/async close', pass: cross.statSync('/cross/rw.txt').size === 8 });
    await cross.closeVfs();
    cross = null;
    self.postMessage({ type: 'RESULT', result: { results } });
  } catch (error) {
    if (cross) await cross.closeVfs();
    self.postMessage({ type: 'ERROR', error: formatError(error) });
  }
};
