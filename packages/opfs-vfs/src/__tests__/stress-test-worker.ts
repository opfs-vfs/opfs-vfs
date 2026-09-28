import { OpenFlags, OpfsVfs } from '../opfs-vfs';

self.onmessage = async (event: MessageEvent) => {
  const { type } = event.data;

  if (type === 'RUN_STRESS_TEST') {
    let vfs: OpfsVfs | null = null;
    try {
      const fileName = `stress-test-${Math.random().toString(36).substring(7)}.bin`;
      vfs = new OpfsVfs(fileName);
      await vfs.ready;

      const FILE_COUNT = 500;
      const results: { check: string; pass: boolean; detail?: string }[] = [];

      // --- Create deep directory structure ---
      vfs.mkdirSync('/data');
      for (let i = 0; i < 10; i++) {
        vfs.mkdirSync(`/data/dir${i}`);
        for (let j = 0; j < 5; j++) {
          vfs.mkdirSync(`/data/dir${i}/sub${j}`);
        }
      }

      // --- Write 500 files across directories ---
      const writeStart = performance.now();
      for (let i = 0; i < FILE_COUNT; i++) {
        const dir = Math.floor(i / 50);
        const sub = Math.floor((i % 50) / 10);
        const path = `/data/dir${dir}/sub${sub}/file${i}.dat`;
        const fd = vfs.openSync(path, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
        // Each file has unique content: file index repeated to fill variable sizes
        const size = 100 + (i % 4000); // 100 bytes to ~4KB
        const content = new Uint8Array(size);
        for (let b = 0; b < size; b++) content[b] = (i + b) % 256;
        vfs.writeSync(fd, content, 0);
        vfs.closeSync(fd);
      }
      const writeMs = Math.round(performance.now() - writeStart);

      // --- Verify all 500 files readable with correct content ---
      const readStart = performance.now();
      let readErrors = 0;
      for (let i = 0; i < FILE_COUNT; i++) {
        const dir = Math.floor(i / 50);
        const sub = Math.floor((i % 50) / 10);
        const path = `/data/dir${dir}/sub${sub}/file${i}.dat`;
        const expectedSize = 100 + (i % 4000);

        const stat = vfs.statSync(path);
        if (stat.size !== expectedSize) {
          readErrors++;
          continue;
        }

        const fd = vfs.openSync(path, OpenFlags.O_RDONLY);
        const { buffer, read } = vfs.readSync(fd, expectedSize, 0);
        vfs.closeSync(fd);

        if (read !== expectedSize) {
          readErrors++;
          continue;
        }
        // Spot-check first, middle, last byte
        if (buffer[0] !== (i + 0) % 256) {
          readErrors++;
          continue;
        }
        const mid = Math.floor(expectedSize / 2);
        if (buffer[mid] !== (i + mid) % 256) {
          readErrors++;
          continue;
        }
        if (buffer[expectedSize - 1] !== (i + expectedSize - 1) % 256) {
          readErrors++;
        }
      }
      const readMs = Math.round(performance.now() - readStart);

      results.push({ check: '500 files written', pass: true, detail: `${writeMs}ms` });
      results.push({
        check: '500 files read+verified',
        pass: readErrors === 0,
        detail: `${readMs}ms, ${readErrors} errors`,
      });

      // --- Verify directory listings ---
      const topEntries = vfs.readdirSync('/data').filter((entry) => entry !== '.' && entry !== '..');
      results.push({ check: '/data has 10 dirs', pass: topEntries.length === 10 });

      const subEntries = vfs.readdirSync('/data/dir0').filter((entry) => entry !== '.' && entry !== '..');
      results.push({ check: '/data/dir0 has 5 subdirs', pass: subEntries.length === 5 });

      const fileEntries = vfs.readdirSync('/data/dir0/sub0').filter((entry) => entry !== '.' && entry !== '..');
      results.push({
        check: '/data/dir0/sub0 has 10 files',
        pass: fileEntries.length === 10,
        detail: `got ${fileEntries.length}`,
      });

      // --- Sync + reopen: verify persistence of 500 files ---
      vfs.syncSync();
      await vfs.closeVfs();
      vfs = null;

      const vfs2 = new OpfsVfs(fileName);
      await vfs2.ready;

      const reopenStart = performance.now();
      let reopenErrors = 0;
      for (let i = 0; i < FILE_COUNT; i++) {
        const dir = Math.floor(i / 50);
        const sub = Math.floor((i % 50) / 10);
        const path = `/data/dir${dir}/sub${sub}/file${i}.dat`;
        const expectedSize = 100 + (i % 4000);

        if (!vfs2.existsSync(path)) {
          reopenErrors++;
          continue;
        }
        const stat = vfs2.statSync(path);
        if (stat.size !== expectedSize) {
          reopenErrors++;
          continue;
        }

        const fd = vfs2.openSync(path, OpenFlags.O_RDONLY);
        const { buffer, read } = vfs2.readSync(fd, expectedSize, 0);
        vfs2.closeSync(fd);

        if (read !== expectedSize) {
          reopenErrors++;
          continue;
        }
        if (buffer[0] !== (i + 0) % 256) {
          reopenErrors++;
        }
      }
      const reopenMs = Math.round(performance.now() - reopenStart);

      results.push({
        check: '500 files persist after reopen',
        pass: reopenErrors === 0,
        detail: `${reopenMs}ms, ${reopenErrors} errors`,
      });

      // --- Rename and delete stress ---
      vfs2.renameSync('/data/dir0/sub0/file0.dat', '/data/dir0/sub0/renamed.dat');
      results.push({
        check: 'rename works',
        pass: vfs2.existsSync('/data/dir0/sub0/renamed.dat') && !vfs2.existsSync('/data/dir0/sub0/file0.dat'),
      });

      vfs2.removeSync('/data/dir0/sub0/renamed.dat');
      results.push({ check: 'delete works', pass: !vfs2.existsSync('/data/dir0/sub0/renamed.dat') });

      const afterDelete = vfs2.readdirSync('/data/dir0/sub0').filter((entry) => entry !== '.' && entry !== '..');
      results.push({
        check: 'dir listing updated after delete',
        pass: afterDelete.length === 9,
        detail: `got ${afterDelete.length}`,
      });

      await vfs2.closeVfs();

      self.postMessage({ type: 'RESULT', results });
    } catch (error) {
      if (vfs) await vfs.closeVfs();
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? (error.stack ?? '') : '';
      self.postMessage({ type: 'ERROR', error: `${msg}\n${stack}` });
    }
  }
};
