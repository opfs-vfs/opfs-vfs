import { DATA_WAL_VERSION, encodeDataWalRecord } from '../data-wal';
import { OpenFlags, OpfsVfs } from '../opfs-vfs';

/** Open a raw SyncAccessHandle on a sidecar file (e.g. `.data.log`). */
async function openRawSidecar(fileName: string, suffix: string) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(fileName.replace(/\.bin$/, suffix), { create: true });
  return (
    handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
  ).createSyncAccessHandle();
}

type CrashCloseVfs = {
  closed: boolean;
  storageHandles?: Array<{ close(): void }>;
  storage?: { destroy(): void };
  logHandle?: { close(): void; getSize?(): number };
  dataLogHandle?: { close(): void; getSize?(): number };
  bitmapHandle?: { close(): void };
  metaHandleA?: { close(): void };
  metaHandleB?: { close(): void };
  bootstrapHandle?: { close(): void };
  dataHandle?: { close(): void };
};

function formatError(error: unknown) {
  return `${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? (error.stack ?? '') : ''}`;
}

function simulateCrashClose(vfs: OpfsVfs) {
  const crashVfs = vfs as unknown as CrashCloseVfs;
  crashVfs.closed = true;
  void (vfs as unknown as { releaseVolumeLock?: () => Promise<void> }).releaseVolumeLock?.();
  crashVfs.logHandle?.close();
  crashVfs.dataLogHandle?.close();
  crashVfs.bitmapHandle?.close();
  crashVfs.metaHandleA?.close();
  crashVfs.metaHandleB?.close();
  crashVfs.bootstrapHandle?.close();
  crashVfs.dataHandle?.close();
  for (const handle of crashVfs.storageHandles ?? []) handle.close();
  crashVfs.storage?.destroy();
  crashVfs.storage = undefined;
  crashVfs.storageHandles = [];
}

self.onmessage = async (event) => {
  const { type } = event.data;

  if (type === 'RUN_PERSISTENCE_TEST') {
    try {
      const fileName = `persist-test-${Math.random().toString(36).substring(7)}.bin`;

      // --- Mount 1: create files, write data, sync, close ---
      const vfs1 = new OpfsVfs(fileName);
      await vfs1.ready;

      vfs1.mkdirSync('/mydir');
      vfs1.mkdirSync('/mydir/sub');

      // Write a file with known content
      const fd1 = vfs1.openSync('/mydir/hello.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs1.writeSync(fd1, new TextEncoder().encode('persistence works!'), 0);
      vfs1.closeSync(fd1);

      // Write a binary file
      const fd2 = vfs1.openSync('/mydir/sub/numbers.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs1.writeSync(fd2, new Uint8Array([1, 2, 3, 4, 5, 42, 255]), 0);
      vfs1.closeSync(fd2);

      // Write a large file spanning multiple blocks (>4KB)
      const fd3 = vfs1.openSync('/bigfile.dat', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      const bigData = new Uint8Array(10000);
      for (let i = 0; i < bigData.length; i++) bigData[i] = i % 256;
      vfs1.writeSync(fd3, bigData, 0);
      vfs1.closeSync(fd3);
      vfs1.chmodSync('/mydir', 16872);
      vfs1.chmodSync('/mydir/hello.txt', 33152);
      vfs1.utimesSync('/mydir/hello.txt', 1712345000000, 1712345689000);

      // Sync metadata + close VFS (releases OPFS handles)
      vfs1.syncSync();
      await vfs1.closeVfs();

      // --- Mount 2: reopen same files, verify everything ---
      const vfs2 = new OpfsVfs(fileName);
      await vfs2.ready;

      const results: { check: string; pass: boolean; detail?: string }[] = [];

      // Verify directories exist
      results.push({ check: 'dir /mydir exists', pass: vfs2.existsSync('/mydir') });
      results.push({ check: 'dir /mydir/sub exists', pass: vfs2.existsSync('/mydir/sub') });
      results.push({ check: '/mydir is_dir', pass: vfs2.statSync('/mydir').is_dir });

      // Verify directory listing
      const entries = vfs2.readdirSync('/mydir');
      results.push({ check: 'readdir has hello.txt', pass: entries.includes('hello.txt') });
      results.push({ check: 'readdir has sub', pass: entries.includes('sub') });

      // Verify text file content
      const rfd1 = vfs2.openSync('/mydir/hello.txt', OpenFlags.O_RDONLY);
      const res1 = vfs2.readSync(rfd1, 100, 0);
      const text = new TextDecoder().decode(res1.buffer);
      results.push({ check: 'hello.txt content', pass: text === 'persistence works!', detail: `got "${text}"` });
      results.push({ check: 'hello.txt read count', pass: res1.read === 18, detail: `got ${res1.read}` });
      vfs2.closeSync(rfd1);

      // Verify binary file
      const rfd2 = vfs2.openSync('/mydir/sub/numbers.bin', OpenFlags.O_RDONLY);
      const res2 = vfs2.readSync(rfd2, 100, 0);
      results.push({ check: 'numbers.bin length', pass: res2.read === 7, detail: `got ${res2.read}` });
      const binMatch = res2.read === 7 && [1, 2, 3, 4, 5, 42, 255].every((v, i) => res2.buffer[i] === v);
      results.push({ check: 'numbers.bin content', pass: binMatch });
      vfs2.closeSync(rfd2);

      // Verify large multi-block file
      const rfd3 = vfs2.openSync('/bigfile.dat', OpenFlags.O_RDONLY);
      const res3 = vfs2.readSync(rfd3, 10000, 0);
      results.push({ check: 'bigfile.dat length', pass: res3.read === 10000, detail: `got ${res3.read}` });
      let bigMatch = res3.read === 10000;
      if (bigMatch) {
        for (let i = 0; i < 10000; i++) {
          if (res3.buffer[i] !== i % 256) {
            bigMatch = false;
            break;
          }
        }
      }
      results.push({ check: 'bigfile.dat content', pass: bigMatch });
      vfs2.closeSync(rfd3);

      // Verify file sizes via stat
      results.push({ check: 'hello.txt size', pass: vfs2.statSync('/mydir/hello.txt').size === 18 });
      results.push({ check: 'numbers.bin size', pass: vfs2.statSync('/mydir/sub/numbers.bin').size === 7 });
      results.push({ check: 'bigfile.dat size', pass: vfs2.statSync('/bigfile.dat').size === 10000 });
      results.push({ check: '/mydir mode', pass: vfs2.statSync('/mydir').mode === 16872 });
      results.push({ check: 'hello.txt mode', pass: vfs2.statSync('/mydir/hello.txt').mode === 33152 });
      results.push({
        check: 'hello.txt timestamp',
        pass: vfs2.statSync('/mydir/hello.txt').timestampMs === 1712345689000,
        detail: `got ${vfs2.statSync('/mydir/hello.txt').timestampMs}`,
      });

      await vfs2.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_NAMESPACE_RULES_TEST') {
    try {
      const fileName = `namespace-test-${Math.random().toString(36).substring(7)}.bin`;
      const vfs = new OpfsVfs(fileName);
      await vfs.ready;

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      vfs.mkdirSync('/root');
      vfs.mkdirSync('/root/nested');
      const fd = vfs.openSync('/root/nested/file.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(fd, encoder.encode('payload'), 0);
      vfs.closeSync(fd);

      vfs.renameSync('/root/nested', '/root/moved');
      results.push({
        check: 'rename dir rekeys descendants',
        pass: !vfs.existsSync('/root/nested/file.txt') && vfs.existsSync('/root/moved/file.txt'),
      });
      const movedFd = vfs.openSync('/root/moved/file.txt', OpenFlags.O_RDONLY);
      const movedRes = vfs.readSync(movedFd, 32, 0);
      results.push({
        check: 'rename dir preserves file data',
        pass: decoder.decode(movedRes.buffer) === 'payload',
      });
      vfs.closeSync(movedFd);

      vfs.mkdirSync('/trash');
      vfs.mkdirSync('/trash/tree');
      const trashFd = vfs.openSync('/trash/tree/keep.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(trashFd, encoder.encode('keep'), 0);
      vfs.closeSync(trashFd);
      vfs.mkdirSync('/trash/tree/sub');
      const trashFd2 = vfs.openSync('/trash/tree/sub/deep.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(trashFd2, encoder.encode('deep'), 0);
      vfs.closeSync(trashFd2);
      vfs.removeSync('/trash/tree');
      results.push({
        check: 'remove dir deletes subtree',
        pass:
          !vfs.existsSync('/trash/tree') &&
          !vfs.existsSync('/trash/tree/keep.txt') &&
          !vfs.existsSync('/trash/tree/sub/deep.txt'),
      });
      results.push({ check: 'remove dir keeps parent', pass: vfs.existsSync('/trash') });

      const targetFd = vfs.openSync('/target.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(targetFd, encoder.encode('target'), 0);
      vfs.closeSync(targetFd);
      const renameSourceFd = vfs.openSync('/rename-source.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(renameSourceFd, encoder.encode('rename-source'), 0);
      vfs.closeSync(renameSourceFd);
      let renameMissingParentRejected = false;
      try {
        vfs.renameSync('/rename-source.txt', '/missing-parent/child.txt');
      } catch {
        renameMissingParentRejected = true;
      }
      results.push({ check: 'rename validates missing parent', pass: renameMissingParentRejected });
      const renameParentFd = vfs.openSync('/rename-parent.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.closeSync(renameParentFd);
      const renameChildSourceFd = vfs.openSync('/rename-child-source.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(renameChildSourceFd, encoder.encode('rename-child-source'), 0);
      vfs.closeSync(renameChildSourceFd);
      let renameNonDirParentRejected = false;
      try {
        vfs.renameSync('/rename-child-source.txt', '/rename-parent.txt/child.txt');
      } catch {
        renameNonDirParentRejected = true;
      }
      results.push({ check: 'rename rejects file parent', pass: renameNonDirParentRejected });
      const sourceFd = vfs.openSync('/source.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(sourceFd, encoder.encode('source'), 0);
      vfs.closeSync(sourceFd);
      vfs.renameSync('/source.txt', '/target.txt');
      const replacedFd = vfs.openSync('/target.txt', OpenFlags.O_RDONLY);
      const replacedRead = vfs.readSync(replacedFd, 16, 0);
      vfs.closeSync(replacedFd);
      results.push({
        check: 'rename replaces existing file target',
        pass: !vfs.existsSync('/source.txt') && vfs.existsSync('/target.txt'),
      });
      results.push({
        check: 'rename replacement keeps source contents',
        pass: decoder.decode(replacedRead.buffer) === 'source',
      });

      const lockedFd = vfs.openSync('/locked.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(lockedFd, encoder.encode('locked'), 0);
      vfs.renameSync('/locked.txt', '/locked-renamed.txt');
      const lockedRead = vfs.readSync(lockedFd, 16, 0);
      vfs.removeSync('/locked-renamed.txt');
      const lockedReadAfterRemove = vfs.readSync(lockedFd, 16, 0);
      results.push({
        check: 'rename rekeys open fd',
        pass: decoder.decode(lockedRead.buffer) === 'locked',
      });
      results.push({
        check: 'remove keeps open fd readable until close',
        pass: decoder.decode(lockedReadAfterRemove.buffer) === 'locked',
      });
      vfs.closeSync(lockedFd);
      results.push({
        check: 'removed path stays unlinked after close',
        pass: !vfs.existsSync('/locked.txt') && !vfs.existsSync('/locked-renamed.txt'),
      });

      let openDirRejected = false;
      try {
        vfs.openSync('/root', OpenFlags.O_RDONLY);
      } catch {
        openDirRejected = true;
      }
      results.push({ check: 'openSync rejects directories', pass: openDirRejected });

      let missingParentRejected = false;
      try {
        vfs.openSync('/missing-parent/file.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      } catch {
        missingParentRejected = true;
      }
      results.push({ check: 'openSync validates parent path', pass: missingParentRejected });

      vfs.mkdirSync('/file-parent');
      const parentFd = vfs.openSync('/file-parent/child-parent.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.closeSync(parentFd);
      const parentFileFd = vfs.openSync('/file-parent-file.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.closeSync(parentFileFd);
      let nonDirParentRejected = false;
      try {
        vfs.openSync('/file-parent-file.txt/child.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      } catch {
        nonDirParentRejected = true;
      }
      results.push({ check: 'openSync rejects file parent', pass: nonDirParentRejected });

      let negativeSeekRejected = false;
      const seekFd = vfs.openSync('/seek.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      try {
        vfs.seekSync(seekFd, -1, 0);
      } catch {
        negativeSeekRejected = true;
      }
      vfs.closeSync(seekFd);
      results.push({ check: 'seekSync rejects negative offsets', pass: negativeSeekRejected });

      let truncateDirRejected = false;
      try {
        vfs.truncateSync('/root', 0);
      } catch {
        truncateDirRejected = true;
      }
      results.push({ check: 'truncateSync rejects directories', pass: truncateDirRejected });

      await vfs.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_DISK_GROWTH_TEST') {
    try {
      const fileName = `disk-growth-${Math.random().toString(36).substring(7)}.bin`;
      const vfs = new OpfsVfs(fileName, { bufferMode: 'disk' });
      await vfs.ready;

      const encoder = new TextEncoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      vfs.mkdirSync('/disk');
      const growFd = vfs.openSync('/disk/grow.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(growFd, encoder.encode('abc'), 0);
      vfs.truncateSync('/disk/grow.bin', 6000);
      vfs.closeSync(growFd);

      const sparseFd = vfs.openSync('/disk/sparse.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(sparseFd, encoder.encode('xyz'), 4096);
      vfs.closeSync(sparseFd);

      vfs.syncSync();
      await vfs.closeVfs();

      const reopened = new OpfsVfs(fileName, { bufferMode: 'disk' });
      await reopened.ready;

      const reopenGrowFd = reopened.openSync('/disk/grow.bin', OpenFlags.O_RDONLY);
      const growRead = reopened.readSync(reopenGrowFd, 6000, 0);
      reopened.closeSync(reopenGrowFd);
      const growPrefixOk = new TextDecoder().decode(growRead.buffer.slice(0, 3)) === 'abc';
      const growTailZero = growRead.buffer.slice(3).every((b) => b === 0);
      results.push({
        check: 'truncate growth round-trips with zero-filled tail',
        pass: growRead.read === 6000 && growPrefixOk && growTailZero,
        detail: `read=${growRead.read}`,
      });

      const reopenSparseFd = reopened.openSync('/disk/sparse.bin', OpenFlags.O_RDONLY);
      const sparseRead = reopened.readSync(reopenSparseFd, 4099, 0);
      reopened.closeSync(reopenSparseFd);
      const sparseHeadZero = sparseRead.buffer.slice(0, 4096).every((b) => b === 0);
      const sparsePayloadOk = new TextDecoder().decode(sparseRead.buffer.slice(4096)) === 'xyz';
      results.push({
        check: 'sparse write round-trips with zero-filled gap',
        pass: sparseRead.read === 4099 && sparseHeadZero && sparsePayloadOk,
        detail: `read=${sparseRead.read}`,
      });

      await reopened.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_POST_FLUSH_MUTATION_TEST') {
    try {
      const fileName = `post-flush-mutation-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'disk' });
      await vfs.ready;

      const keepFd = vfs.openSync('/keep.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(keepFd, encoder.encode('keep'), 0);
      vfs.closeSync(keepFd);

      const transientFd = vfs.openSync('/postmaster.pid', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(transientFd, encoder.encode('transient'), 0);
      vfs.closeSync(transientFd);

      vfs.flushVfs();

      vfs.removeSync('/postmaster.pid');
      const lateFd = vfs.openSync('/late.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(lateFd, encoder.encode('late'), 0);
      vfs.closeSync(lateFd);

      await vfs.closeVfs();

      const reopened = new OpfsVfs(fileName, { bufferMode: 'disk' });
      await reopened.ready;

      results.push({
        check: 'deletion after flush persists',
        pass: !reopened.existsSync('/postmaster.pid'),
      });

      const keepReadFd = reopened.openSync('/keep.txt', OpenFlags.O_RDONLY);
      const keepRead = reopened.readSync(keepReadFd, 16, 0);
      reopened.closeSync(keepReadFd);
      results.push({
        check: 'pre-flush file persists',
        pass: decoder.decode(keepRead.buffer) === 'keep',
      });

      const lateReadFd = reopened.openSync('/late.txt', OpenFlags.O_RDONLY);
      const lateRead = reopened.readSync(lateReadFd, 16, 0);
      reopened.closeSync(lateReadFd);
      results.push({
        check: 'new file after flush persists',
        pass: decoder.decode(lateRead.buffer) === 'late',
      });

      await reopened.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_DISK_BALANCED_AUTO_FLUSH_TEST' || type === 'RUN_DEFAULT_AUTO_FLUSH_TEST') {
    try {
      const fileName = `disk-balanced-auto-flush-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const options =
        type === 'RUN_DEFAULT_AUTO_FLUSH_TEST'
          ? undefined
          : { bufferMode: 'disk' as const, localDurabilityMode: 'balanced' as const };
      const vfs = new OpfsVfs(fileName, options);
      await vfs.ready;

      const fd = vfs.openSync('/balanced.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(fd, encoder.encode('balanced survives'), 0);
      vfs.closeSync(fd);

      const pending = vfs.getLocalPersistenceStatusSync();
      results.push({
        check: 'writes use disk buffering',
        pass: pending.dirtyPages === 0 && pending.walPendingBytes === 0,
      });
      const deadline = Date.now() + 3000;
      while (vfs.getLocalPersistenceStatusSync().localPersistenceState !== 'clean' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const statusAfterDebounce = vfs.getLocalPersistenceStatusSync();
      results.push({
        check: 'disk balanced debounce reaches clean state',
        pass: statusAfterDebounce.localPersistenceState === 'clean',
        detail: `state=${statusAfterDebounce.localPersistenceState}`,
      });

      simulateCrashClose(vfs);

      const reopened = new OpfsVfs(fileName, options);
      await reopened.ready;

      results.push({
        check: 'disk balanced debounced flush persists namespace',
        pass: reopened.existsSync('/balanced.txt'),
      });

      if (reopened.existsSync('/balanced.txt')) {
        const readFd = reopened.openSync('/balanced.txt', OpenFlags.O_RDONLY);
        const read = reopened.readSync(readFd, 64, 0);
        reopened.closeSync(readFd);
        results.push({
          check: 'disk balanced debounced flush persists data',
          pass: decoder.decode(read.buffer) === 'balanced survives',
          detail: `got "${decoder.decode(read.buffer)}"`,
        });
      } else {
        results.push({
          check: 'disk balanced debounced flush persists data',
          pass: false,
          detail: 'file missing',
        });
      }

      await reopened.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_HARDLINK_LOG_RECOVERY_TEST') {
    try {
      const fileName = `hardlink-log-recovery-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await vfs.ready;

      const createFd = vfs.openSync('/shared.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(createFd, encoder.encode('alpha'), 0);
      vfs.closeSync(createFd);

      vfs.linkSync('/shared.txt', '/alias.txt');
      const rewriteFd = vfs.openSync('/alias.txt', OpenFlags.O_WRONLY | OpenFlags.O_TRUNC);
      vfs.writeSync(rewriteFd, encoder.encode('beta'), 0);
      vfs.closeSync(rewriteFd);
      vfs.unlinkSync('/shared.txt');

      vfs.syncSync();
      const logSize = (vfs as unknown as CrashCloseVfs).logHandle?.getSize?.() ?? 0;
      results.push({
        check: 'hard-link update used incremental metadata log',
        pass: logSize > 0,
        detail: `logSize=${logSize}`,
      });

      simulateCrashClose(vfs);

      const reopened = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await reopened.ready;

      results.push({
        check: 'removed hard-link path stays absent after replay',
        pass: !reopened.existsSync('/shared.txt'),
      });
      results.push({
        check: 'surviving hard-link path remains present after replay',
        pass: reopened.existsSync('/alias.txt'),
      });
      results.push({
        check: 'surviving hard-link path keeps decremented nlink after replay',
        pass: reopened.statSync('/alias.txt').nlink === 1,
        detail: `nlink=${reopened.statSync('/alias.txt').nlink}`,
      });
      const readFd = reopened.openSync('/alias.txt', OpenFlags.O_RDONLY);
      const read = reopened.readSync(readFd, 16, 0);
      reopened.closeSync(readFd);
      results.push({
        check: 'surviving hard-link path keeps latest file contents after replay',
        pass: decoder.decode(read.buffer) === 'beta',
        detail: `got "${decoder.decode(read.buffer)}"`,
      });

      await reopened.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_HARDLINK_REOPEN_TEST') {
    try {
      const fileName = `hardlink-reopen-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await vfs.ready;

      const createFd = vfs.openSync('/shared.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(createFd, encoder.encode('linked'), 0);
      vfs.closeSync(createFd);
      vfs.linkSync('/shared.txt', '/alias.txt');

      vfs.syncSync();
      await vfs.closeVfs();

      const reopened = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await reopened.ready;

      results.push({
        check: 'both hard-link paths survive clean reopen',
        pass: reopened.existsSync('/shared.txt') && reopened.existsSync('/alias.txt'),
      });
      results.push({
        check: 'clean reopen preserves shared file link count',
        pass: reopened.statSync('/shared.txt').nlink === 2 && reopened.statSync('/alias.txt').nlink === 2,
        detail: `shared=${reopened.statSync('/shared.txt').nlink}, alias=${reopened.statSync('/alias.txt').nlink}`,
      });
      const readFd = reopened.openSync('/alias.txt', OpenFlags.O_RDONLY);
      const read = reopened.readSync(readFd, 16, 0);
      reopened.closeSync(readFd);
      results.push({
        check: 'clean reopen preserves shared file contents',
        pass: decoder.decode(read.buffer) === 'linked',
        detail: `got "${decoder.decode(read.buffer)}"`,
      });

      await reopened.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_CRASH_RECOVERY_TEST') {
    try {
      const fileName = `memory-wal-crash-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory', localDurabilityMode: 'strict' });
      await vfs.ready;
      const fd = vfs.openSync('/crash.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(fd, encoder.encode('abc'), 0);
      vfs.writeSync(fd, encoder.encode('XYZ'), 4094);
      vfs.ftruncateSync(fd, 6);
      vfs.closeSync(fd);

      simulateCrashClose(vfs);

      const reopened = new OpfsVfs(fileName, { bufferMode: 'memory', localDurabilityMode: 'strict' });
      await reopened.ready;
      const rf = reopened.openSync('/crash.txt', OpenFlags.O_RDONLY);
      const read = reopened.readSync(rf, 32, 0);
      reopened.closeSync(rf);
      const text = decoder.decode(read.buffer);
      results.push({
        check: 'recovered data from memory WAL after crash',
        pass: text === 'abc\u0000\u0000\u0000',
        detail: text,
      });
      results.push({
        check: 'recovered truncate from memory WAL after crash',
        pass: reopened.statSync('/crash.txt').size === 6,
      });

      const statusBeforeSync = reopened.getLocalPersistenceStatusSync();
      results.push({
        check: 'status exposes dirty WAL after crash replay',
        pass: statusBeforeSync.walPendingBytes > 0,
      });
      reopened.syncSync();
      const statusAfterSync = reopened.getLocalPersistenceStatusSync();
      results.push({ check: 'strict sync clears WAL pending bytes', pass: statusAfterSync.walPendingBytes === 0 });
      results.push({
        check: 'strict sync transitions to clean state',
        pass: statusAfterSync.localPersistenceState === 'clean',
      });

      await reopened.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_PARTIAL_TRAILING_TEST') {
    try {
      const fileName = `memory-wal-partial-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await vfs.ready;
      const fd = vfs.openSync('/partial.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(fd, encoder.encode('ok'), 0);
      vfs.closeSync(fd);
      simulateCrashClose(vfs);

      const root = await navigator.storage.getDirectory();
      const dataLogFile = await root.getFileHandle(fileName.replace(/\.bin$/, '.data.log'), { create: true });
      const dataLogHandle = await (
        dataLogFile as FileSystemFileHandle & { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
      ).createSyncAccessHandle();
      const currentSize = dataLogHandle.getSize();
      dataLogHandle.write(new Uint8Array([1, 2, 3]), { at: currentSize });
      dataLogHandle.flush();
      dataLogHandle.close();

      const reopened = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await reopened.ready;
      const rf = reopened.openSync('/partial.txt', OpenFlags.O_RDONLY);
      const read = reopened.readSync(rf, 8, 0);
      reopened.closeSync(rf);
      results.push({
        check: 'partial trailing WAL bytes are ignored safely',
        pass: decoder.decode(read.buffer) === 'ok',
      });
      await reopened.closeVfs();

      const badFileName = `memory-wal-corrupt-${Math.random().toString(36).substring(7)}.bin`;
      const bad = new OpfsVfs(badFileName, { bufferMode: 'memory' });
      await bad.ready;
      const bfd = bad.openSync('/bad.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      bad.writeSync(bfd, encoder.encode('bad'), 0);
      bad.closeSync(bfd);
      simulateCrashClose(bad);

      const badLogFile = await root.getFileHandle(badFileName.replace(/\.bin$/, '.data.log'), { create: true });
      const badLogHandle = await (
        badLogFile as FileSystemFileHandle & { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
      ).createSyncAccessHandle();
      const payload = new Uint8Array(badLogHandle.getSize());
      badLogHandle.read(payload, { at: 0 });
      payload[payload.length - 1] ^= 0xff;
      badLogHandle.truncate(0);
      badLogHandle.write(payload, { at: 0 });
      badLogHandle.flush();
      badLogHandle.close();

      // INT-5: a checksum mismatch on the only WAL frame must NOT brick init.
      // The corrupt frame (at byte 0) is discarded, the WAL is truncated, and
      // the mount succeeds with the salvage surfaced via the persistence status.
      let salvageMountThrew = false;
      let salvageDetail = `log bytes: ${payload.length}`;
      let salvaged: OpfsVfs | undefined;
      try {
        salvaged = new OpfsVfs(badFileName, { bufferMode: 'memory' });
        await salvaged.ready;
      } catch (error) {
        salvageMountThrew = true;
        salvageDetail = `${salvageDetail}; ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      }
      results.push({
        check: 'corrupt-checksum WAL mounts via salvage instead of bricking',
        pass: !salvageMountThrew,
        detail: salvageDetail,
      });
      if (salvaged) {
        const status = salvaged.getLocalPersistenceStatusSync();
        results.push({
          check: 'salvage event surfaced for checksum mismatch',
          pass: status.lastSalvage?.reason === 'corrupt-frame',
          detail: `lastSalvage=${JSON.stringify(status.lastSalvage)}`,
        });
        // The namespace entry is persisted via the meta log (independent of the
        // data WAL), so /bad.txt may still exist — but its corrupt data write
        // was discarded, so its contents must NOT be the original 'bad'.
        let badContent = '';
        if (salvaged.existsSync('/bad.txt')) {
          const badFd = salvaged.openSync('/bad.txt', OpenFlags.O_RDONLY);
          badContent = decoder.decode(salvaged.readSync(badFd, 16, 0).buffer);
          salvaged.closeSync(badFd);
        }
        results.push({
          check: 'corrupt data-WAL record discarded (original bytes gone)',
          pass: badContent !== 'bad',
          detail: `content="${badContent}"`,
        });
        // The salvaged WAL must accept new writes and survive a clean reopen.
        const newFd = salvaged.openSync('/after-salvage.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
        salvaged.writeSync(newFd, encoder.encode('healthy'), 0);
        salvaged.closeSync(newFd);
        salvaged.syncSync();
        await salvaged.closeVfs();

        const reopenedAfterSalvage = new OpfsVfs(badFileName, { bufferMode: 'memory' });
        await reopenedAfterSalvage.ready;
        const afterFd = reopenedAfterSalvage.openSync('/after-salvage.txt', OpenFlags.O_RDONLY);
        const afterRead = reopenedAfterSalvage.readSync(afterFd, 16, 0);
        reopenedAfterSalvage.closeSync(afterFd);
        results.push({
          check: 'writes after checksum salvage persist across reopen',
          pass: decoder.decode(afterRead.buffer) === 'healthy',
        });
        await reopenedAfterSalvage.closeVfs();
      }

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_POISON_RECORD_SALVAGE_TEST') {
    try {
      // INT-5 (a): a valid record followed by a record whose APPLICATION throws
      // (a pre-SEC-2-style write at an offset past maxFileSize). Remount must
      // succeed, the valid record's effect must be present, the poison record
      // and the WAL tail at/after it must be truncated, salvage surfaced.
      const fileName = `memory-wal-poison-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await vfs.ready;
      const fd = vfs.openSync('/keep.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(fd, encoder.encode('first'), 0);
      vfs.closeSync(fd);
      const keepIno = vfs.statSync('/keep.txt').ino;
      // Crash without flush so the legit write stays in the uncheckpointed WAL.
      simulateCrashClose(vfs);

      // Append a poison frame: a CRC-valid write to the real inode at an offset
      // far beyond maxFileSize (4 GiB). decode succeeds; applyReplayWrite's
      // bounds check throws → the harness stops and truncates here.
      const dataLogHandle = await openRawSidecar(fileName, '.data.log');
      const cleanWalBytes = dataLogHandle.getSize();
      const poison = encodeDataWalRecord({
        version: DATA_WAL_VERSION,
        op: 'write',
        inodeId: keepIno,
        path: '/keep.txt',
        offset: 5_000_000_000,
        data: new Uint8Array([1, 2, 3]),
      });
      dataLogHandle.write(poison, { at: cleanWalBytes });
      dataLogHandle.flush();
      dataLogHandle.close();

      let mountThrew = false;
      let salvaged: OpfsVfs | undefined;
      try {
        salvaged = new OpfsVfs(fileName, { bufferMode: 'memory' });
        await salvaged.ready;
      } catch {
        mountThrew = true;
      }
      results.push({ check: 'poison-record WAL mounts instead of bricking', pass: !mountThrew });

      if (salvaged) {
        const readFd = salvaged.openSync('/keep.txt', OpenFlags.O_RDONLY);
        const read = salvaged.readSync(readFd, 16, 0);
        salvaged.closeSync(readFd);
        results.push({
          check: 'valid record before poison applied on salvage',
          pass: decoder.decode(read.buffer) === 'first',
          detail: `got "${decoder.decode(read.buffer)}"`,
        });
        const status = salvaged.getLocalPersistenceStatusSync();
        results.push({
          check: 'salvage event surfaced as apply-failure',
          pass: status.lastSalvage?.reason === 'apply-failure',
          detail: `lastSalvage=${JSON.stringify(status.lastSalvage)}`,
        });
        results.push({
          check: 'WAL truncated at poison frame boundary',
          pass: status.lastSalvage?.truncatedAt === cleanWalBytes,
          detail: `truncatedAt=${status.lastSalvage?.truncatedAt} expected=${cleanWalBytes}`,
        });

        const newFd = salvaged.openSync('/after.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
        salvaged.writeSync(newFd, encoder.encode('healthy'), 0);
        salvaged.closeSync(newFd);
        salvaged.syncSync();
        await salvaged.closeVfs();

        const reopened = new OpfsVfs(fileName, { bufferMode: 'memory' });
        await reopened.ready;
        const afterFd = reopened.openSync('/after.txt', OpenFlags.O_RDONLY);
        const afterRead = reopened.readSync(afterFd, 16, 0);
        reopened.closeSync(afterFd);
        const keepStillFd = reopened.openSync('/keep.txt', OpenFlags.O_RDONLY);
        const keepStill = reopened.readSync(keepStillFd, 16, 0);
        reopened.closeSync(keepStillFd);
        results.push({
          check: 'subsequent writes + clean remount work after poison salvage',
          pass: decoder.decode(afterRead.buffer) === 'healthy' && decoder.decode(keepStill.buffer) === 'first',
        });
        await reopened.closeVfs();
      }

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_MIDLOG_CORRUPTION_SALVAGE_TEST') {
    try {
      // INT-5 (b): a 3-frame WAL with frame N (the 2nd) byte-flipped. Remount
      // must apply frames before N, discard N AND everything after it (frame
      // N+1's effect must be absent even though it individually checksums), and
      // truncate at N's boundary.
      const fileName = `memory-wal-midlog-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await vfs.ready;
      const fd = vfs.openSync('/seq.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      // Three separate appends → three WAL write frames over the same inode.
      vfs.writeSync(fd, encoder.encode('AAA'), 0);
      vfs.writeSync(fd, encoder.encode('BBB'), 3);
      vfs.writeSync(fd, encoder.encode('CCC'), 6);
      vfs.closeSync(fd);
      simulateCrashClose(vfs);

      // Decode the three frames to find frame #2's boundaries, then corrupt its
      // payload (leaving frame #3 individually valid).
      const dataLogHandle = await openRawSidecar(fileName, '.data.log');
      const size = dataLogHandle.getSize();
      const bytes = new Uint8Array(size);
      dataLogHandle.read(bytes, { at: 0 });
      const FRAME_HEADER_BYTES = 8;
      const frameStarts: number[] = [];
      let cursor = 0;
      while (cursor + FRAME_HEADER_BYTES <= bytes.length) {
        frameStarts.push(cursor);
        const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, FRAME_HEADER_BYTES);
        const payloadLen = view.getUint32(0, true);
        cursor += FRAME_HEADER_BYTES + payloadLen;
      }
      const frameCountOk = frameStarts.length === 3;
      results.push({
        check: 'three WAL frames present (precondition)',
        pass: frameCountOk,
        detail: `frames=${frameStarts.length}`,
      });
      const secondFrameStart = frameStarts[1];
      // Flip a payload byte of frame #2 → checksum mismatch at this boundary.
      bytes[secondFrameStart + FRAME_HEADER_BYTES] ^= 0xff;
      dataLogHandle.truncate(0);
      dataLogHandle.write(bytes, { at: 0 });
      dataLogHandle.flush();
      dataLogHandle.close();

      let mountThrew = false;
      let salvaged: OpfsVfs | undefined;
      try {
        salvaged = new OpfsVfs(fileName, { bufferMode: 'memory' });
        await salvaged.ready;
      } catch {
        mountThrew = true;
      }
      results.push({ check: 'mid-WAL corruption mounts instead of bricking', pass: !mountThrew });

      if (salvaged) {
        const readFd = salvaged.openSync('/seq.txt', OpenFlags.O_RDONLY);
        const read = salvaged.readSync(readFd, 16, 0);
        salvaged.closeSync(readFd);
        const text = decoder.decode(read.buffer);
        // Frame #1 (AAA@0) applied; frame #2 (BBB@3) corrupt → discarded; frame
        // #3 (CCC@6) discarded too (ordering integrity lost past corruption).
        results.push({
          check: 'frames before corruption applied; corrupt frame and after discarded',
          pass: text === 'AAA',
          detail: `got "${text}"`,
        });
        const status = salvaged.getLocalPersistenceStatusSync();
        results.push({
          check: 'salvage truncated at corrupt frame boundary',
          pass: status.lastSalvage?.reason === 'corrupt-frame' && status.lastSalvage?.truncatedAt === secondFrameStart,
          detail: `lastSalvage=${JSON.stringify(status.lastSalvage)} expectedBoundary=${secondFrameStart}`,
        });
        await salvaged.closeVfs();
      }

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_RECOVERY_MODE_TEST') {
    // §6.2: same corrupt 3-frame WAL as the midlog salvage test, mounted twice:
    // once fail-stop (must throw a typed DataWalCorruptionError, state 'error'),
    // once salvage (must mount, pass through 'recovering', stay usable).
    try {
      const fileName = `memory-wal-recovery-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await vfs.ready;
      const fd = vfs.openSync('/seq.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(fd, encoder.encode('AAA'), 0);
      vfs.writeSync(fd, encoder.encode('BBB'), 3);
      vfs.writeSync(fd, encoder.encode('CCC'), 6);
      vfs.closeSync(fd);
      simulateCrashClose(vfs);

      const dataLogHandle = await openRawSidecar(fileName, '.data.log');
      const size = dataLogHandle.getSize();
      const bytes = new Uint8Array(size);
      dataLogHandle.read(bytes, { at: 0 });
      const FRAME_HEADER_BYTES = 8;
      const frameStarts: number[] = [];
      let cursor = 0;
      while (cursor + FRAME_HEADER_BYTES <= bytes.length) {
        frameStarts.push(cursor);
        const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, FRAME_HEADER_BYTES);
        const payloadLen = view.getUint32(0, true);
        cursor += FRAME_HEADER_BYTES + payloadLen;
      }
      const secondFrameStart = frameStarts[1];
      bytes[secondFrameStart + FRAME_HEADER_BYTES] ^= 0xff;
      dataLogHandle.truncate(0);
      dataLogHandle.write(bytes, { at: 0 });
      dataLogHandle.flush();
      dataLogHandle.close();

      // fail-stop: mount must throw a typed, categorized corruption error.
      let failStopError: unknown;
      try {
        const failStop = new OpfsVfs(fileName, { bufferMode: 'memory', recoveryMode: 'fail-stop' });
        await failStop.ready;
        await failStop.closeVfs();
      } catch (error) {
        failStopError = error;
      }
      results.push({
        check: 'fail-stop throws a typed data-wal corruption error',
        pass:
          !!failStopError &&
          (failStopError as { name?: string }).name === 'DataWalCorruptionError' &&
          (failStopError as { category?: string }).category === 'data-wal',
        detail: `error=${formatError(failStopError)}`,
      });

      // salvage: mount succeeds, frames before corruption applied, state usable.
      const salvaged = new OpfsVfs(fileName, { bufferMode: 'memory', recoveryMode: 'salvage' });
      await salvaged.ready;
      const readFd = salvaged.openSync('/seq.txt', OpenFlags.O_RDONLY);
      const text = decoder.decode(salvaged.readSync(readFd, 16, 0).buffer);
      salvaged.closeSync(readFd);
      const status = salvaged.getLocalPersistenceStatusSync();
      results.push({
        check: 'salvage mounts and keeps pre-corruption data',
        pass: text === 'AAA' && status.lastSalvage?.reason === 'corrupt-frame',
        detail: `text="${text}" lastSalvage=${JSON.stringify(status.lastSalvage)}`,
      });
      // The DB is usable after salvage: a fresh write + read round-trips.
      const wfd = salvaged.openSync('/after.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      salvaged.writeSync(wfd, encoder.encode('ok'), 0);
      const afterText = decoder.decode(salvaged.readSync(wfd, 2, 0).buffer);
      salvaged.closeSync(wfd);
      results.push({ check: 'salvaged DB is usable for new writes', pass: afterText === 'ok' });
      await salvaged.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_DURABLE_REOPEN_TEST') {
    try {
      const fileName = `memory-wal-durable-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const vfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await vfs.ready;

      const writeFd = vfs.openSync('/grow.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(writeFd, encoder.encode('abc'), 0);
      vfs.writeSync(writeFd, encoder.encode('XYZ'), 4094);
      vfs.closeSync(writeFd);
      simulateCrashClose(vfs);

      const recovered = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await recovered.ready;
      recovered.syncSync();
      await recovered.closeVfs();

      const reopened = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await reopened.ready;
      const reopenFd = reopened.openSync('/grow.bin', OpenFlags.O_RDONLY);
      const reopenRead = reopened.readSync(reopenFd, 5000, 0);
      reopened.closeSync(reopenFd);
      results.push({
        check: 'write crash recovery survives second reopen after sync/close',
        pass:
          reopened.statSync('/grow.bin').size === 4097 && reopenRead.buffer[0] === 97 && reopenRead.buffer[4096] === 90,
      });
      await reopened.closeVfs();

      const trunc = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await trunc.ready;
      const truncFd = trunc.openSync('/grow.bin', OpenFlags.O_RDWR);
      trunc.ftruncateSync(truncFd, 2);
      trunc.closeSync(truncFd);
      simulateCrashClose(trunc);

      const truncRecovered = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await truncRecovered.ready;
      truncRecovered.syncSync();
      await truncRecovered.closeVfs();

      const truncReopen = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await truncReopen.ready;
      const truncReadFd = truncReopen.openSync('/grow.bin', OpenFlags.O_RDONLY);
      const truncRead = truncReopen.readSync(truncReadFd, 16, 0);
      truncReopen.closeSync(truncReadFd);
      results.push({
        check: 'truncate crash recovery survives second reopen after sync/close',
        pass: truncReopen.statSync('/grow.bin').size === 2 && decoder.decode(truncRead.buffer) === 'ab',
      });
      await truncReopen.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_DELETE_REPLAY_TEST') {
    try {
      const fileName = `memory-wal-delete-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const deleted = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await deleted.ready;
      const deleteFd = deleted.openSync('/delete-me.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      deleted.writeSync(deleteFd, encoder.encode('remove'), 0);
      deleted.closeSync(deleteFd);
      deleted.syncSync();
      deleted.unlinkSync('/delete-me.bin');
      simulateCrashClose(deleted);

      const deleteRecovered = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await deleteRecovered.ready;
      results.push({
        check: 'delete crash recovery removes stale namespace entry',
        pass: !deleteRecovered.existsSync('/delete-me.bin'),
      });
      deleteRecovered.syncSync();
      await deleteRecovered.closeVfs();

      const deleteReopen = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await deleteReopen.ready;
      results.push({
        check: 'delete crash recovery survives second reopen after sync/close',
        pass: !deleteReopen.existsSync('/delete-me.bin'),
      });
      await deleteReopen.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_MEMORY_WAL_LINK_RENAME_RECOVERY_TEST') {
    try {
      const fileName = `memory-wal-rename-link-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const renamedVfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await renamedVfs.ready;
      const renamedFd = renamedVfs.openSync('/before.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      renamedVfs.writeSync(renamedFd, encoder.encode('rename-data'), 0);
      renamedVfs.closeSync(renamedFd);
      renamedVfs.renameSync('/before.txt', '/after.txt');
      simulateCrashClose(renamedVfs);

      const renamedRecovered = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await renamedRecovered.ready;
      const readRenamedFd = renamedRecovered.openSync('/after.txt', OpenFlags.O_RDONLY);
      const renamedRead = renamedRecovered.readSync(readRenamedFd, 32, 0);
      renamedRecovered.closeSync(readRenamedFd);
      results.push({
        check: 'write+rename crash recovery resolves by inode (not stale path)',
        pass: decoder.decode(renamedRead.buffer) === 'rename-data',
      });
      await renamedRecovered.closeVfs();

      const hardlinkVfs = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await hardlinkVfs.ready;
      hardlinkVfs.linkSync('/after.txt', '/linked.txt');
      const writeLinkedFd = hardlinkVfs.openSync('/after.txt', OpenFlags.O_RDWR);
      hardlinkVfs.writeSync(writeLinkedFd, encoder.encode('live'), 0);
      hardlinkVfs.ftruncateSync(writeLinkedFd, 4);
      hardlinkVfs.closeSync(writeLinkedFd);
      hardlinkVfs.unlinkSync('/after.txt');
      simulateCrashClose(hardlinkVfs);

      const hardlinkRecovered = new OpfsVfs(fileName, { bufferMode: 'memory' });
      await hardlinkRecovered.ready;
      const linkedFd = hardlinkRecovered.openSync('/linked.txt', OpenFlags.O_RDONLY);
      const linkedRead = hardlinkRecovered.readSync(linkedFd, 16, 0);
      hardlinkRecovered.closeSync(linkedFd);
      results.push({
        check: 'hardlink survives unlink(original)+crash with latest data',
        pass: decoder.decode(linkedRead.buffer) === 'live',
      });
      results.push({
        check: 'unlink cleanup does not remove data when hardlink remains',
        pass: hardlinkRecovered.existsSync('/linked.txt') && !hardlinkRecovered.existsSync('/after.txt'),
      });
      await hardlinkRecovered.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_DISK_TORN_WRITE_RECOVERY_TEST') {
    try {
      const fileName = `disk-torn-write-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      // 1. Cleanly write a multi-block file + a small survivor, then close so
      //    meta durably references every allocated block.
      const vfs = new OpfsVfs(fileName, { bufferMode: 'disk', localDurabilityMode: 'balanced' });
      await vfs.ready;
      // Create the survivor first so it occupies a *lower* block than big.bin's
      // tail; truncating the physical tail then only drops big.bin's blocks.
      const keepFd = vfs.openSync('/keep.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(keepFd, encoder.encode('keep'), 0);
      vfs.closeSync(keepFd);
      const bigFd = vfs.openSync('/big.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      const bigPayload = new Uint8Array(4096 * 4); // 4 blocks
      for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = (i % 251) + 1;
      vfs.writeSync(bigFd, bigPayload, 0);
      vfs.closeSync(bigFd);
      vfs.flushVfs();
      await vfs.closeVfs();

      // 2. Simulate a torn final data flush: truncate the raw data file so meta
      //    still references blocks that are no longer physically present. This
      //    is the on-disk shape that produced "read only 0 of 8192 bytes".
      const root = await navigator.storage.getDirectory();
      const dataFileHandle = await root.getFileHandle(fileName);
      const rawHandle = await (
        dataFileHandle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
      ).createSyncAccessHandle();
      const fullSize = rawHandle.getSize();
      // Drop the last 4KB block of physical data — belongs to big.bin's tail.
      rawHandle.truncate(Math.max(0, fullSize - 4096));
      rawHandle.flush();
      rawHandle.close();

      // 3. Reopen — reconcileDiskState must repair the torn state in init().
      const reopened = new OpfsVfs(fileName, { bufferMode: 'disk', localDurabilityMode: 'balanced' });
      await reopened.ready;

      // Reading the torn file must NOT throw a short-read error; it is clamped
      // to whatever data physically survived.
      let bigReadThrew = false;
      let bigReadBytes = 0;
      try {
        const reopenBigFd = reopened.openSync('/big.bin', OpenFlags.O_RDONLY);
        const stat = reopened.fstatSync(reopenBigFd);
        const bigRead = reopened.readSync(reopenBigFd, stat.size, 0);
        bigReadBytes = bigRead.read;
        reopened.closeSync(reopenBigFd);
      } catch {
        bigReadThrew = true;
      }
      results.push({
        check: 'torn file reads without short-read error',
        pass: !bigReadThrew,
        detail: `readBytes=${bigReadBytes}`,
      });
      results.push({
        check: 'torn file clamped below original size',
        pass: !bigReadThrew && bigReadBytes < 4096 * 4,
        detail: `readBytes=${bigReadBytes} (original=${4096 * 4})`,
      });

      // The untouched survivor file must still be intact.
      const keepReadFd = reopened.openSync('/keep.txt', OpenFlags.O_RDONLY);
      const keepRead = reopened.readSync(keepReadFd, 16, 0);
      reopened.closeSync(keepReadFd);
      results.push({
        check: 'unaffected file survives reconciliation',
        pass: decoder.decode(keepRead.buffer) === 'keep',
      });

      // 4. After repair, new writes/reads work and survive a second reopen.
      const newFd = reopened.openSync('/after-repair.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      reopened.writeSync(newFd, encoder.encode('healthy'), 0);
      reopened.closeSync(newFd);
      reopened.flushVfs();
      await reopened.closeVfs();

      const reopenedAgain = new OpfsVfs(fileName, { bufferMode: 'disk', localDurabilityMode: 'balanced' });
      await reopenedAgain.ready;
      const afterFd = reopenedAgain.openSync('/after-repair.txt', OpenFlags.O_RDONLY);
      const afterRead = reopenedAgain.readSync(afterFd, 16, 0);
      reopenedAgain.closeSync(afterFd);
      results.push({
        check: 'writes after repair persist across reopen',
        pass: decoder.decode(afterRead.buffer) === 'healthy',
      });
      await reopenedAgain.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_DISK_TORN_WRITE_NONMONOTONIC_TEST') {
    try {
      const fileName = `disk-torn-nonmono-${Math.random().toString(36).substring(7)}.bin`;
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      // Build a non-monotonic block table. Block numbers are NOT ordered by
      // file offset: Bitmap.alloc reuses freed low blocks. Sequence:
      //   - /a.bin takes a low block (e.g. 1)
      //   - /b.bin takes higher blocks (e.g. 2,3,4)
      //   - delete /a.bin -> frees block 1, lowers the alloc hint
      //   - extend /b.bin by one page -> that page reuses block 1
      //   => /b.bin.blocks looks like [2, 3, 4, 1]
      const vfs = new OpfsVfs(fileName, { bufferMode: 'disk', localDurabilityMode: 'balanced' });
      await vfs.ready;

      const aFd = vfs.openSync('/a.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs.writeSync(aFd, new Uint8Array(4096).fill(7), 0); // 1 block
      vfs.closeSync(aFd);

      const bFd = vfs.openSync('/b.bin', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      const bPayload = new Uint8Array(4096 * 3); // 3 blocks
      for (let i = 0; i < bPayload.length; i++) bPayload[i] = (i % 251) + 1;
      vfs.writeSync(bFd, bPayload, 0);
      vfs.closeSync(bFd);

      vfs.removeSync('/a.bin'); // free the low block, lower the alloc hint

      const bExtendFd = vfs.openSync('/b.bin', OpenFlags.O_RDWR);
      // Append a 4th page; it should reuse the freed low block.
      vfs.writeSync(bExtendFd, new Uint8Array(4096).fill(9), 4096 * 3);
      vfs.closeSync(bExtendFd);

      // Force a deterministic non-monotonic table so the test does not depend on
      // allocator hints. We rewrite b.bin's block list to [hi0, hi1, MISSING, lo]
      // where the 3rd page points past the physical extent but the 4th (low)
      // page survives — the dangling-MIDDLE case the trailing-only loop missed.
      const inodes = (vfs as unknown as { inodes: Map<string, { blocks: number[]; size: number }> }).inodes;
      const bInode = inodes.get('/b.bin')!;
      // After the steps above, b.bin owns 4 distinct blocks. Reorder them so the
      // largest sits in a middle page and the smallest is last.
      const owned = [...bInode.blocks].sort((a, b) => a - b); // ascending
      const lo = owned[0];
      const hi = owned[owned.length - 1];
      const mids = owned.slice(1, -1);
      // [mids..., hi(middle page), lo(last page)] — hi is NOT the last entry.
      bInode.blocks = [...mids, hi, lo];
      bInode.size = bInode.blocks.length * 4096;
      vfs.flushVfs();

      const bBlocks = [...bInode.blocks];
      await vfs.closeVfs();

      // Precondition: a higher block precedes a lower one (non-monotonic) AND the
      // out-of-range block is NOT the last entry.
      const lastBlock = bBlocks[bBlocks.length - 1];
      const hasHigherBeforeLast = bBlocks.slice(0, -1).some((b) => b > lastBlock);
      results.push({
        check: 'block table is non-monotonic with a non-final high block (precondition)',
        pass: hasHigherBeforeLast,
        detail: `blocks=[${bBlocks.join(',')}]`,
      });

      // Truncate the physical data file just below the highest block so that a
      // MIDDLE logical page points past EOF while the last (low) page survives.
      const root = await navigator.storage.getDirectory();
      const dataFileHandle = await root.getFileHandle(fileName);
      const rawHandle = await (
        dataFileHandle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
      ).createSyncAccessHandle();
      rawHandle.truncate(hi * 4096); // drops block `hi` (a middle page) and above
      rawHandle.flush();
      rawHandle.close();

      const reopened = new OpfsVfs(fileName, { bufferMode: 'disk', localDurabilityMode: 'balanced' });
      await reopened.ready;

      // The file must be clamped to the FIRST missing page. The hole is at page
      // `mids.length` (the `hi` block), so only the leading `mids.length` pages
      // survive. The buggy trailing-only loop kept all pages (size unchanged),
      // leaving the dangling middle block readable -> short physical read.
      const expectedClampedSize = mids.length * 4096;
      const rfd = reopened.openSync('/b.bin', OpenFlags.O_RDONLY);
      const recoveredSize = reopened.fstatSync(rfd).size;
      // Every byte within the clamped size must come from a physically-present
      // block (no short read), so reading the whole clamped range returns it all.
      const fullRead = reopened.readSync(rfd, recoveredSize, 0);
      reopened.closeSync(rfd);
      results.push({
        check: 'non-monotonic torn file clamped to first missing page',
        pass: recoveredSize === expectedClampedSize,
        detail: `size=${recoveredSize} expected=${expectedClampedSize} blocks=[${bBlocks.join(',')}]`,
      });
      results.push({
        check: 'clamped range is fully readable (no dangling middle block)',
        pass: fullRead.read === recoveredSize,
        detail: `read=${fullRead.read} size=${recoveredSize}`,
      });

      // After repair, the surviving blocks must still be re-readable, writable,
      // and durable across another reopen.
      const wfd = reopened.openSync('/recovered.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      reopened.writeSync(wfd, new TextEncoder().encode('ok'), 0);
      reopened.closeSync(wfd);
      reopened.flushVfs();
      await reopened.closeVfs();

      const again = new OpfsVfs(fileName, { bufferMode: 'disk', localDurabilityMode: 'balanced' });
      await again.ready;
      const rfd2 = again.openSync('/recovered.txt', OpenFlags.O_RDONLY);
      const r2 = again.readSync(rfd2, 8, 0);
      again.closeSync(rfd2);
      results.push({
        check: 'writes after non-monotonic repair persist',
        pass: decoder.decode(r2.buffer) === 'ok',
      });
      await again.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_NO_LEGACY_META_SIDECAR_TEST') {
    try {
      const fileName = `no-legacy-meta-${Math.random().toString(36).substring(7)}.bin`;
      const vfs = new OpfsVfs(fileName);
      await vfs.ready;
      await vfs.closeVfs();

      const root = await navigator.storage.getDirectory();
      let legacyMetaExists = true;
      try {
        await root.getFileHandle(fileName.replace(/\.bin$/, '.meta'), { create: false });
      } catch (error) {
        if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'NotFoundError') {
          legacyMetaExists = false;
        } else {
          throw error;
        }
      }

      self.postMessage({
        type: 'RESULT',
        results: [{ check: 'fresh volume omits retired .meta sidecar', pass: !legacyMetaExists }],
      });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_RETIRED_META_REJECTED_TEST') {
    try {
      const fileName = `retired-meta-${Math.random().toString(36).substring(7)}.bin`;
      const retired = await openRawSidecar(fileName, '.meta');
      retired.write(new Uint8Array([0x42, 0x56, 0x46, 0x53]), { at: 0 });
      retired.flush();
      retired.close();

      let category = '';
      try {
        const vfs = new OpfsVfs(fileName);
        await vfs.ready;
        await vfs.closeVfs();
      } catch (error) {
        category =
          error && typeof error === 'object' && 'category' in error
            ? String((error as { category?: unknown }).category)
            : '';
      }

      self.postMessage({
        type: 'RESULT',
        results: [
          {
            check: 'retired .meta-only volume fails with format-version error',
            pass: category === 'format-version',
            detail: `category=${category}`,
          },
        ],
      });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  // ── INT-1: atomic meta snapshot swap with corruption fallback ──

  // (a) Corrupting/truncating the active meta snapshot slot after a flush must
  //     still allow a full namespace recovery from the other (older but
  //     consistent) slot or the just-superseded one.
  if (type === 'RUN_META_SNAPSHOT_FALLBACK_TEST') {
    try {
      const fileName = `meta-fallback-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const getRawHandle = async (suffix: string) => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(fileName.replace(/\.bin$/, suffix), { create: true });
        return (
          handle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
        ).createSyncAccessHandle();
      };

      // A full-snapshot rewrite (the INT-1 swap path) only runs from flushVfs/
      // closeVfs, and it alternates A↔B per swap. Two close cycles therefore
      // leave BOTH slots holding a valid, consistent snapshot — the second
      // (higher-sequence) one being authoritative.
      //
      // Mount 1 → snapshot into slot B (seq 1): the baseline namespace.
      const vfs1 = new OpfsVfs(fileName);
      await vfs1.ready;
      vfs1.mkdirSync('/dir');
      const fd = vfs1.openSync('/dir/file.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs1.writeSync(fd, encoder.encode('namespace survives'), 0);
      vfs1.closeSync(fd);
      await vfs1.closeVfs();

      // Mount 2 → snapshot into slot A (seq 2, now authoritative): add /dir/sub.
      const vfs1b = new OpfsVfs(fileName);
      await vfs1b.ready;
      vfs1b.mkdirSync('/dir/sub');
      await vfs1b.closeVfs();

      // Determine which slot is active (the higher-sequence one) and destroy it
      // to simulate a crash that left the latest snapshot torn/corrupt.
      const SNAPSHOT_HEADER = 16;
      const readSeq = async (suffix: string) => {
        const h = await getRawHandle(suffix);
        const size = h.getSize();
        if (size < SNAPSHOT_HEADER) {
          h.close();
          return -1;
        }
        const buf = new Uint8Array(SNAPSHOT_HEADER);
        h.read(buf, { at: 0 });
        const view = new DataView(buf.buffer);
        const seq = view.getUint32(0, true) === 0x534e4150 ? view.getUint32(4, true) : -1;
        h.close();
        return seq;
      };
      const seqA = await readSeq('.meta.a');
      const seqB = await readSeq('.meta.b');
      const activeSuffix = seqA >= seqB ? '.meta.a' : '.meta.b';
      results.push({
        check: 'both A/B slots written after two flushes',
        pass: seqA > 0 && seqB > 0,
        detail: `seqA=${seqA} seqB=${seqB}`,
      });

      // Corrupt the active slot: flip a payload byte so its CRC no longer
      // matches (header magic/sequence stay intact, so this exercises the
      // checksum-rejection path rather than a missing-magic path).
      const corruptHandle = await getRawHandle(activeSuffix);
      const flip = new Uint8Array(1);
      corruptHandle.read(flip, { at: 16 }); // first payload byte (after 16B header)
      flip[0] = flip[0] ^ 0xff;
      corruptHandle.write(flip, { at: 16 });
      corruptHandle.flush();
      corruptHandle.close();

      // Mount 2: must recover the full namespace from the surviving slot.
      const vfs2 = new OpfsVfs(fileName);
      await vfs2.ready;
      results.push({ check: 'namespace recovered: /dir exists', pass: vfs2.existsSync('/dir') });
      results.push({
        check: 'namespace recovered: /dir/file.txt exists',
        pass: vfs2.existsSync('/dir/file.txt'),
      });
      let content = '';
      if (vfs2.existsSync('/dir/file.txt')) {
        const rfd = vfs2.openSync('/dir/file.txt', OpenFlags.O_RDONLY);
        const r = vfs2.readSync(rfd, 64, 0);
        content = decoder.decode(r.buffer.subarray(0, r.read));
        vfs2.closeSync(rfd);
      }
      results.push({
        check: 'file content intact after fallback',
        pass: content === 'namespace survives',
        detail: content,
      });
      // The corrupt slot must be rewritten on the next flush and recover cleanly.
      vfs2.mkdirSync('/after');
      vfs2.syncSync();
      await vfs2.closeVfs();

      const vfs3 = new OpfsVfs(fileName);
      await vfs3.ready;
      results.push({
        check: 'writes after fallback persist',
        pass: vfs3.existsSync('/after') && vfs3.existsSync('/dir'),
      });
      await vfs3.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  // (b) Empty A/B + non-empty `.bin`/`.bitmap` with no valid fallback
  //     must surface a typed corruption error, NOT a silent fresh mount.
  if (type === 'RUN_META_SNAPSHOT_CORRUPTION_TYPED_ERROR_TEST') {
    try {
      const fileName = `meta-corrupt-${Math.random().toString(36).substring(7)}.bin`;
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const getRawHandle = async (name: string) => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(name, { create: true });
        return (
          handle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
        ).createSyncAccessHandle();
      };

      // Fabricate the post-crash shape: a non-empty data file + bitmap, but all
      // snapshot files (.meta.a and .meta.b) empty — exactly what an interrupted
      // in-place snapshot write could leave behind.
      const dataHandle = await getRawHandle(fileName);
      dataHandle.write(new Uint8Array(4096).fill(7), { at: 0 });
      dataHandle.flush();
      dataHandle.close();
      const bitmapHandle = await getRawHandle(fileName.replace(/\.bin$/, '.bitmap'));
      bitmapHandle.write(new Uint8Array(64).fill(0xff), { at: 0 });
      bitmapHandle.flush();
      bitmapHandle.close();

      let threw = false;
      let errorName = '';
      try {
        const vfs = new OpfsVfs(fileName);
        await vfs.ready;
        await vfs.closeVfs();
      } catch (error) {
        threw = true;
        errorName = error instanceof Error ? error.name : String(error);
      }
      results.push({
        check: 'empty meta + non-empty data surfaces typed corruption error',
        pass: threw && errorName === 'MetaSnapshotCorruptionError',
        detail: `threw=${threw} name=${errorName}`,
      });

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  // ── INT-2: bind the meta log to its snapshot generation ──

  // (a) The INT-2 crash window: the new snapshot flushed but the OLD .meta.log
  //     was not yet truncated. Replanting the old log (carrying the OLD
  //     generation) over the new snapshot must NOT replay — its transaction generation no longer
  //     matches the loaded snapshot's sequence, so it is discarded, not rewound.
  if (type === 'RUN_META_LOG_STALE_GENERATION_DISCARDED_TEST') {
    try {
      const fileName = `meta-gen-stale-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const getRawHandle = async (suffix: string) => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(fileName.replace(/\.bin$/, suffix), { create: true });
        return (
          handle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
        ).createSyncAccessHandle();
      };
      const readLog = async () => {
        const h = await getRawHandle('.meta.log');
        const size = h.getSize();
        const buf = new Uint8Array(size);
        if (size > 0) h.read(buf, { at: 0 });
        h.close();
        return buf;
      };
      const writeLog = async (bytes: Uint8Array) => {
        const h = await getRawHandle('.meta.log');
        h.truncate(0);
        if (bytes.byteLength > 0) h.write(bytes, { at: 0 });
        h.flush();
        h.close();
      };

      const OLD_MTIME = 1_700_000_000_000;
      const NEW_MTIME = 1_800_000_000_000;

      // Mount 1: create /dir/file.txt and snapshot it (mkdir+create set
      // dirtyStructure → full snapshot, at generation G).
      // Then an INCREMENTAL mutation (utimes sets only dirtyInodes, no new
      // namespace entry) appends a record carrying OLD_MTIME onto the gen-G log.
      // Capture that log: it is the pre-snapshot garbage the crash window leaks.
      const vfs1 = new OpfsVfs(fileName);
      await vfs1.ready;
      vfs1.mkdirSync('/dir');
      const fd1 = vfs1.openSync('/dir/file.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs1.writeSync(fd1, encoder.encode('content'), 0);
      vfs1.closeSync(fd1);
      vfs1.syncSync(); // full snapshot at generation G
      vfs1.utimesSync('/dir/file.txt', OLD_MTIME, OLD_MTIME); // incremental
      vfs1.syncSync(); // append OLD_MTIME upsert onto gen-G log
      // Crash-close (no forced snapshot) so the gen-G log survives intact; then
      // read it once vfs1's handle is released (a second SyncAccessHandle on a
      // still-open file throws "No modification allowed").
      simulateCrashClose(vfs1);
      const oldLog = await readLog();

      results.push({
        check: 'captured non-empty old-generation log',
        pass: oldLog.byteLength > 16,
        detail: `len=${oldLog.byteLength}`,
      });

      // Mount 2: set NEW_MTIME, then closeVfs forces a full snapshot at
      // generation G+1 that bakes in NEW_MTIME and truncates the log.
      const vfs2 = new OpfsVfs(fileName);
      await vfs2.ready;
      vfs2.utimesSync('/dir/file.txt', NEW_MTIME, NEW_MTIME);
      await vfs2.closeVfs(); // full snapshot at generation G+1

      // Simulate the crash window: re-plant the OLD log (generation G, carrying
      // the OLD_MTIME upsert with its stale block table) over the truncated
      // log. A pre-INT-2 mount would replay it and rewind file.txt to OLD_MTIME;
      // INT-2 must detect the generation mismatch and discard the log instead.
      await writeLog(oldLog);

      // Mount 3: must load the G+1 snapshot and DISCARD the stale G log.
      const vfs3 = new OpfsVfs(fileName);
      await vfs3.ready;
      const stat = vfs3.statSync('/dir/file.txt');
      results.push({
        check: 'file still present after stale-log discard',
        pass: vfs3.existsSync('/dir/file.txt'),
      });
      results.push({
        check: 'stale log discarded: mtime NOT rewound to OLD_MTIME',
        pass: Math.round(stat.mtimeMs ?? 0) === NEW_MTIME,
        detail: `mtimeMs=${stat.mtimeMs} expected=${NEW_MTIME}`,
      });
      // The log must have been truncated on mount (stale-generation discard).
      // Crash-close (no forced snapshot) before reading so the on-disk size
      // reflects the mount-time truncation, not a fresh closeVfs snapshot.
      simulateCrashClose(vfs3);
      const logAfter = await readLog();
      results.push({
        check: 'stale log truncated on mount',
        pass: logAfter.byteLength === 0,
        detail: `len=${logAfter.byteLength}`,
      });

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  // (b) Normal crash recovery: uncheckpointed incremental records carrying the
  //     CURRENT generation must replay after a crash (no rewind, no loss).
  if (type === 'RUN_META_LOG_CURRENT_GENERATION_REPLAYS_TEST') {
    try {
      const fileName = `meta-gen-current-${Math.random().toString(36).substring(7)}.bin`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      const NEW_MTIME = 1_750_000_000_000;

      // Mount 1: create /base/added.txt and snapshot it (full snapshot starts
      // a new generation for the current generation). Then an INCREMENTAL mutation
      // (utimes → dirtyInodes only, appended onto the current log), then CRASH
      // before any further snapshot — leaving an uncheckpointed current-gen log.
      const vfs1 = new OpfsVfs(fileName);
      await vfs1.ready;
      vfs1.mkdirSync('/base');
      const fd1 = vfs1.openSync('/base/added.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs1.writeSync(fd1, encoder.encode('replayed'), 0);
      vfs1.closeSync(fd1);
      vfs1.syncSync(); // full snapshot for current generation
      vfs1.utimesSync('/base/added.txt', NEW_MTIME, NEW_MTIME);
      vfs1.syncSync(); // incremental append, current generation, flushed to log
      simulateCrashClose(vfs1); // crash: handles closed, no further snapshot

      // Mount 2: the current-generation incremental record must replay.
      const vfs2 = new OpfsVfs(fileName);
      await vfs2.ready;
      results.push({ check: 'base namespace present', pass: vfs2.existsSync('/base/added.txt') });
      let content = '';
      if (vfs2.existsSync('/base/added.txt')) {
        const rfd = vfs2.openSync('/base/added.txt', OpenFlags.O_RDONLY);
        const r = vfs2.readSync(rfd, 64, 0);
        content = decoder.decode(r.buffer.subarray(0, r.read));
        vfs2.closeSync(rfd);
      }
      results.push({
        check: 'file content intact after replay',
        pass: content === 'replayed',
        detail: content,
      });
      const stat = vfs2.statSync('/base/added.txt');
      results.push({
        check: 'current-generation incremental record replayed (mtime applied)',
        pass: Math.round(stat.mtimeMs ?? 0) === NEW_MTIME,
        detail: `mtimeMs=${stat.mtimeMs} expected=${NEW_MTIME}`,
      });
      await vfs2.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }

  if (type === 'RUN_BITMAP_REBUILD_HARDLINK_TEST') {
    try {
      const fileName = `bitmap-hardlink-${Math.random().toString(36).substring(7)}.bin`;
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      // Mount 1 (disk mode): write a multi-block file, hard-link a second path
      // to it, sync, crash-close.
      const vfs1 = new OpfsVfs(fileName, { bufferMode: 'disk' });
      await vfs1.ready;
      const DATA = new Uint8Array(9000);
      for (let i = 0; i < DATA.length; i++) DATA[i] = (i * 5 + 1) % 256;
      const fd1 = vfs1.openSync('/a.dat', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      vfs1.writeSync(fd1, DATA, 0);
      vfs1.closeSync(fd1);
      vfs1.linkSync('/a.dat', '/b.dat');
      vfs1.syncSync();
      const ino1 = vfs1.statSync('/a.dat').ino;
      simulateCrashClose(vfs1);

      // Mount 2 (disk mode): rebuild must mark the shared blocks once.
      const vfs2 = new OpfsVfs(fileName, { bufferMode: 'disk' });
      await vfs2.ready;

      const sa = vfs2.statSync('/a.dat');
      const sb = vfs2.statSync('/b.dat');
      results.push({
        check: 'both paths resolve to the same inode',
        pass: sa.ino === sb.ino && sa.ino === ino1,
        detail: `a=${sa.ino} b=${sb.ino}`,
      });
      results.push({ check: 'hard link nlink == 2', pass: sa.nlink === 2, detail: `nlink=${sa.nlink}` });

      // The bitmap must reflect exactly the unique block count (block 0 reserved
      // + the file's blocks, counted once despite two paths). Count set bits and
      // compare to 1 + ceil(size/BLOCK).
      const internal = vfs2 as unknown as { bitmap: { getRawBits(): Uint32Array } };
      const words = internal.bitmap.getRawBits();
      let setBits = 0;
      for (const w of words) {
        let v = w >>> 0;
        while (v) {
          v &= v - 1;
          setBits++;
        }
      }
      const expectedBlocks = 1 + Math.ceil(DATA.length / 4096); // block 0 + file
      results.push({
        check: 'bitmap marks shared blocks exactly once (no double-claim)',
        pass: setBits === expectedBlocks,
        detail: `setBits=${setBits} expected=${expectedBlocks}`,
      });

      // No corruption state was raised (double-claim would set 'error').
      results.push({
        check: 'persistence state not error after hard-link rebuild',
        pass: vfs2.getLocalPersistenceStatusSync().localPersistenceState !== 'error',
        detail: vfs2.getLocalPersistenceStatusSync().localPersistenceState,
      });

      // Content readable through both paths.
      const ra = vfs2.readSync(vfs2.openSync('/a.dat', OpenFlags.O_RDONLY), DATA.length, 0);
      const rb = vfs2.readSync(vfs2.openSync('/b.dat', OpenFlags.O_RDONLY), DATA.length, 0);
      const bothOk =
        ra.read === DATA.length &&
        rb.read === DATA.length &&
        ra.buffer[0] === DATA[0] &&
        rb.buffer[DATA.length - 1] === DATA[DATA.length - 1];
      results.push({ check: 'content readable through both hard-link paths', pass: bothOk });

      await vfs2.closeVfs();
      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      self.postMessage({ type: 'ERROR', error: formatError(error) });
    }
  }
};
