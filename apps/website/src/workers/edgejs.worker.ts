/// <reference lib="webworker" />
import { isVfsError, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { createWasmerFileSystem } from '@opfs-vfs/opfs-vfs/wasmer-sync';
import type { Package, Wasmer } from '../../public/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/dist/index';

export type DemoFile = { path: string; size: number };
export type EdgeJSRequest =
  | { type: 'init' }
  | { type: 'run'; code: string }
  | { type: 'preview'; path: string }
  | { type: 'reset' };
export type EdgeJSResponse =
  | { type: 'status'; message: string }
  | { type: 'ready'; files: DemoFile[]; output?: string; message: string }
  | { type: 'preview'; path: string; text: string }
  | { type: 'error'; message: string; fatal: boolean };

const ASSET_RELEASE = '0.2.0-opfs-vfs.1';
const ASSET_ROOT = `/vendor/edgejs/${ASSET_RELEASE}`;
const SDK_COMMIT = '3bc6d7513ae1cc0db82a4ccf6e70b5f107788be0';
const VOLUME = 'opfs-vfs-website-edgejs.bin';
const OUTPUT_BYTES = 64 * 1024;
const PREVIEW_BYTES = 4096;
let vfs: OpfsVfs | undefined;
let wasmer: Wasmer | undefined;
let guest: Package | undefined;
let busy = false;
let fatal = false;

function send(message: EdgeJSResponse) {
  self.postMessage(message);
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function files(): DemoFile[] {
  const result: DemoFile[] = [];
  const pending = ['/'];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of vfs!.readdirNamesSync(directory)) {
      const path = `${directory === '/' ? '' : directory}/${name}`;
      const stat = vfs!.lstatSync(path);
      if (stat.is_dir) pending.push(path);
      else if (stat.is_file) result.push({ path, size: stat.size });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function init() {
  if (wasmer || vfs) throw new Error('The demo has already started.');
  send({ type: 'status', message: 'Opening demo files…' });
  vfs = new OpfsVfs(VOLUME, {
    bufferMode: 'disk',
    localDurabilityMode: 'relaxed',
    noatime: true,
    maxFiles: 512,
    maxFileSize: 8 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    maxPathDepth: 16,
  });
  try {
    await vfs.ready;
  } catch (error) {
    vfs = undefined;
    if (
      (isVfsError(error) && error.code === 'EBUSY') ||
      (error instanceof DOMException && ['NoModificationAllowedError', 'InvalidStateError'].includes(error.name))
    ) {
      throw new Error('These demo files are open in another tab. Close that tab, then reload this page.');
    }
    throw error;
  }
  send({ type: 'status', message: 'Loading EdgeJS. The first download can take a moment…' });
  const response = await fetch(`${ASSET_ROOT}/build.json`);
  if (!response.ok) throw new Error('The EdgeJS demo assets are unavailable. Please try again later.');
  const build = await response.json();
  if (build.assetRelease !== ASSET_RELEASE || build.sdk?.commit !== SDK_COMMIT) {
    throw new Error('The EdgeJS host build does not match this demo. Reload after the assets have been updated.');
  }
  // An absolute URL keeps Vite from adding ?import to this prebuilt public asset.
  const sdkUrl = new URL(`${ASSET_ROOT}/sdk/dist/index.js`, self.location.origin).href;
  const sdk: typeof import('../../public/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/dist/index') = await import(
    /* @vite-ignore */ sdkUrl
  );
  if (sdk.SYNC_FILESYSTEM_ABI !== 1 || typeof sdk.Wasmer?.create !== 'function') {
    throw new Error('This EdgeJS host does not support live files. See the integration guide for the required build.');
  }
  send({ type: 'status', message: 'Preparing the runtime…' });
  wasmer = await sdk.Wasmer.create({ outputBytes: OUTPUT_BYTES / 2, parallelism: 2 });
  send({ type: 'status', message: 'Downloading the EdgeJS package…' });
  guest = await wasmer.packages.load('wasmer/edgejs@0.2.0');
  send({ type: 'ready', files: files(), message: 'Ready. Run the program to save a counter.' });
}

async function run(code: string) {
  if (code.length > 64 * 1024) throw new Error('Keep the demo program below 64 KiB.');
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sandbox = await wasmer!.sandboxes.create({
      packages: [guest!],
      syncMounts: [{ path: '/data', fs: createWasmerFileSystem(vfs!) }],
      network: { mode: 'disabled' },
    });
    send({ type: 'status', message: 'Running program…' });
    // Spawn can fail after scheduling a guest, so failures from here are uncertain.
    started = true;
    const output = await Promise.race([
      (async () => {
        const process = await sandbox!.command(guest!, ['-e', code], { cwd: '/data' }).spawn({
          timeoutMs: 15_000,
          outputBytes: OUTPUT_BYTES / 2,
          stdout: 'capture',
          stderr: 'capture',
          stdin: 'closed',
        });
        return process.wait();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The program did not confirm it stopped.')), 30_000);
      }),
    ]);
    // The current host's forced termination is not an orderly filesystem barrier.
    if (output.reason !== 'exited') throw new Error('The program exceeded its time limit or was interrupted.');
    stopped = true;
    try {
      await sandbox.close();
      vfs!.syncSync();
    } catch (error) {
      fatal = true;
      throw new Error(`Could not finish saving the program: ${failure(error)} Reload this page.`);
    }
    const truncated = output.stdout.truncated || output.stderr.truncated;
    const outputText = output.stdout.text() + output.stderr.text() + (truncated ? '\n[Output limited to 64 KiB.]' : '');
    send({
      type: 'ready',
      files: files(),
      output: outputText,
      message: output.ok
        ? 'Program finished. Demo files saved.'
        : `Program exited with code ${output.exitCode}. Demo files saved.`,
    });
  } catch (error) {
    if (started && !stopped) {
      fatal = true;
      throw new Error(`${failure(error)} Reload this page before running or inspecting files again.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function handle(request: EdgeJSRequest) {
  if (request.type === 'init') return init();
  if (!vfs || !wasmer || !guest) throw new Error('The demo is still loading.');
  if (request.type === 'run') return run(request.code);
  if (request.type === 'preview') {
    // Only paths from the current listing are selectable; never follow links.
    const file = files().find((entry) => entry.path === request.path);
    if (!file) throw new Error('That file is no longer available.');
    const fd = vfs.openSync(file.path);
    try {
      const text = new TextDecoder().decode(vfs.readSync(fd, PREVIEW_BYTES).buffer);
      send({
        type: 'preview',
        path: file.path,
        text: text + (file.size > PREVIEW_BYTES ? '\n[Preview limited to 4 KiB.]' : ''),
      });
    } finally {
      vfs.closeSync(fd);
    }
  } else if (request.type === 'reset') {
    // This VFS owns only the named demo volume. Never enumerate or delete OPFS volumes.
    for (const name of vfs.readdirNamesSync('/')) vfs.removeSync(`/${name}`);
    vfs.syncSync();
    send({ type: 'ready', files: [], output: '', message: 'Demo files reset. Run the program to start at 1.' });
  }
}

self.onmessage = async ({ data }: MessageEvent<EdgeJSRequest>) => {
  if (fatal || busy) return;
  busy = true;
  try {
    await handle(data);
  } catch (error) {
    let message = failure(error);
    if (data.type === 'init') {
      fatal = true;
      try {
        await wasmer?.close();
        await vfs?.closeVfs();
      } catch (cleanupError) {
        message += ` Cleanup failed: ${failure(cleanupError)}`;
      }
    }
    send({ type: 'error', message, fatal });
  } finally {
    busy = false;
  }
};
