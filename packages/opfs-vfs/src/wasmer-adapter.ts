import type { SandboxFileSystem } from '@wasmer/sdk/browser';
import type { OpfsVfsWorker } from './index_internal';
import { OpfsVfsJustBashAdapter } from './just-bash-adapter';
import type { OpfsVfs } from './opfs-vfs';

/** The public Wasmer SDK 0.14 workspace operations used by this adapter. */
export type WasmerWorkspace = Pick<SandboxFileSystem, 'readDir' | 'readFile' | 'writeFile' | 'mkdir' | 'remove'>;
type Tree = Map<string, Uint8Array | null>;

/**
 * Copies ordinary files and directories between OPFS and Wasmer's /workspace.
 * Each sync mirrors the source, including deletions. Stop guest execution and
 * other writers first. Changes become durable only after OPFS flush/close.
 * Links and metadata are not preserved. Wasmer cannot report symlink identity.
 * A failed destination write can leave a partial copy; sync is not a transaction.
 */
export class OpfsVfsWasmerAdapter {
  private readonly files: OpfsVfsJustBashAdapter;

  constructor(vfs: OpfsVfs | OpfsVfsWorker) {
    this.files = new OpfsVfsJustBashAdapter(vfs);
  }

  async syncToSandbox(workspace: WasmerWorkspace): Promise<void> {
    await this.checkOpfsRoot();
    await mirror(this.opfsWorkspace(), relativeWorkspace(workspace));
  }

  async syncFromSandbox(workspace: WasmerWorkspace): Promise<void> {
    await this.checkOpfsRoot();
    await mirror(relativeWorkspace(workspace), this.opfsWorkspace());
  }

  private async checkOpfsRoot(): Promise<void> {
    const stat = await this.files.lstat('/workspace');
    if (stat.isSymbolicLink || !stat.isDirectory) {
      throw new Error('OPFS /workspace must be an existing directory, not a link');
    }
  }

  private opfsWorkspace(): WasmerWorkspace {
    return {
      readDir: async (path) =>
        (await this.files.readdirWithFileTypes(path)).map((entry) => {
          if (entry.isSymbolicLink || (!entry.isFile && !entry.isDirectory)) {
            throw new Error(`Cannot sync linked or special OPFS entry: ${path}/${entry.name}`);
          }
          return { name: entry.name, kind: entry.isDirectory ? 'directory' : 'file', size: 0 };
        }),
      readFile: (path) => this.files.readFileBuffer(path),
      writeFile: (path, bytes) => this.files.writeFile(path, bytes),
      mkdir: (path) => this.files.mkdir(path, { recursive: true }),
      remove: (path) => this.files.rm(path, { recursive: true }),
    };
  }
}

function relativeWorkspace(fs: WasmerWorkspace): WasmerWorkspace {
  // Relative paths work in both the released WASM and the SDK's documented workspace API.
  const relative = (path: string) => path.slice('/workspace/'.length) || '.';
  return {
    readDir: (path) => fs.readDir(relative(path)),
    readFile: (path) => fs.readFile(relative(path)),
    writeFile: (path, bytes) => fs.writeFile(relative(path), bytes),
    mkdir: (path, options) => fs.mkdir(relative(path), options),
    remove: (path, options) => fs.remove(relative(path), options),
  };
}

async function readTree(
  fs: WasmerWorkspace,
  contents: boolean,
  path = '/workspace',
  depth = 0,
  tree: Tree = new Map(),
): Promise<Tree> {
  // ponytail: bound recursion at 64 levels; an SDK lstat API is needed to identify directory links.
  if (depth > 64) throw new Error('Workspace exceeds 64 directory levels; directory links are unsupported');
  for (const entry of await fs.readDir(path)) {
    if (!entry.name || entry.name === '.' || entry.name === '..' || /[/\0]/.test(entry.name)) {
      throw new Error(`Invalid workspace entry name: ${JSON.stringify(entry.name)}`);
    }
    const child = `${path}/${entry.name}`;
    if (entry.kind === 'directory') {
      tree.set(child, null);
      await readTree(fs, contents, child, depth + 1, tree);
    } else if (entry.kind === 'file') {
      tree.set(child, contents ? await fs.readFile(child) : new Uint8Array());
    } else {
      throw new Error(`Unsupported workspace entry: ${child}`);
    }
  }
  return tree;
}

async function mirror(source: WasmerWorkspace, destination: WasmerWorkspace): Promise<void> {
  // ponytail: whole-tree snapshot uses O(source bytes) memory; use an upstream filesystem provider for large workspaces.
  const snapshot = await readTree(source, true);
  const existing = await readTree(destination, false);
  const remove = async (path: string) => {
    await destination.remove(path, { recursive: true });
    for (const oldPath of existing.keys()) {
      if (oldPath === path || oldPath.startsWith(`${path}/`)) existing.delete(oldPath);
    }
  };

  for (const [path, bytes] of snapshot) {
    // Recreate files so overwrites cannot change another name for a hard-linked inode.
    if (existing.has(path) && (bytes !== null || existing.get(path) !== null)) await remove(path);
    if (bytes === null) await destination.mkdir(path, { recursive: true });
    else await destination.writeFile(path, bytes);
  }
  for (const path of existing.keys()) {
    if (!snapshot.has(path)) await remove(path);
  }
}
