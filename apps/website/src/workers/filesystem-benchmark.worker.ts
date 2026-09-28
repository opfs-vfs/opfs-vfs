/// <reference lib="webworker" />
import { OpfsVfs, OpenFlags, deleteVolume } from '@opfs-vfs/opfs-vfs';
import {
  validateFilesystemConfig,
  type FilesystemConfig,
  type FilesystemEvent,
  type FilesystemSample,
} from '../lib/filesystem-benchmark';
const scope = self as DedicatedWorkerGlobalScope;
const post = (event: FilesystemEvent) => scope.postMessage(event);
scope.onmessage = async ({ data }: MessageEvent<{ config: FilesystemConfig; cancellation: SharedArrayBuffer }>) => {
  const { config } = data,
    cancellation = new Int32Array(data.cancellation);
  const check = () => {
    if (Atomics.load(cancellation, 0)) throw new DOMException('Cancelled', 'AbortError');
  };
  for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    const volume = `website-fs-bench-${crypto.randomUUID()}.bin`;
    let vfs: OpfsVfs | undefined;
    const sample: FilesystemSample = { repetition, mountMs: 0, timings: {}, status: 'failed', verifiedFiles: 0 };
    try {
      validateFilesystemConfig(config);
      check();
      const payload = Uint8Array.from({ length: 1024 }, (_, index) => index % 251);
      const mount = async () => {
        const instance = new OpfsVfs(volume, { bufferMode: config.bufferMode, localDurabilityMode: config.durability });
        vfs = instance;
        await instance.ready;
        return instance;
      };
      let started = performance.now();
      let fs = await mount();
      sample.mountMs = performance.now() - started;
      fs.mkdirSync('/files');
      const timed = (phase: keyof FilesystemSample['timings'], operation: (index: number) => void) => {
        const start = performance.now();
        for (let index = 0; index < config.files; index++) {
          check();
          operation(index);
        }
        sample.timings[phase] = performance.now() - start;
      };
      const verify = (path: string) => {
        const fd = fs.openSync(path);
        try {
          const { buffer, read } = fs.readSync(fd, payload.length);
          if (read !== payload.length || buffer.some((byte, index) => byte !== payload[index]))
            throw new Error(`Content mismatch: ${path}`);
        } finally {
          fs.closeSync(fd);
        }
      };
      timed('create', (index) =>
        fs.closeSync(fs.openSync(`/files/${index}.bin`, OpenFlags.O_CREAT | OpenFlags.O_RDWR)),
      );
      timed('write', (index) => {
        const fd = fs.openSync(`/files/${index}.bin`, OpenFlags.O_RDWR);
        try {
          if (fs.writeSync(fd, payload) !== payload.length) throw new Error('Incomplete write');
        } finally {
          fs.closeSync(fd);
        }
      });
      timed('read', (index) => verify(`/files/${index}.bin`));
      timed('rename', (index) => fs.renameSync(`/files/${index}.bin`, `/files/moved-${index}.bin`));
      timed('delete', (index) => {
        if (index % 2 === 0) fs.unlinkSync(`/files/moved-${index}.bin`);
      });
      check();
      started = performance.now();
      fs.flushVfs();
      sample.timings.flush = performance.now() - started;
      await fs.closeVfs();
      vfs = undefined;
      check();
      started = performance.now();
      fs = await mount();
      sample.timings.reopen = performance.now() - started;
      if (fs.readdirNamesSync('/files').length !== config.files / 2) throw new Error('Reopen file count mismatch');
      for (let index = 1; index < config.files; index += 2) {
        check();
        verify(`/files/moved-${index}.bin`);
        sample.verifiedFiles++;
      }
      sample.status = 'ok';
    } catch (error) {
      sample.status = Atomics.load(cancellation, 0) ? 'cancelled' : 'failed';
      sample.error = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        await vfs?.closeVfs();
        await deleteVolume(volume);
      } catch (error) {
        sample.status = 'failed';
        sample.error = `${sample.error ? `${sample.error} ` : ''}Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    post({ type: 'sample', sample });
    if (Atomics.load(cancellation, 0)) break;
  }
  post({ type: 'done' });
};
