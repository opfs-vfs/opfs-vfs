import type { IFileSystem } from 'just-bash';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { inspectWorker } from '@opfs-vfs/opfs-vfs/worker-client';
import { deleteVolume, peekVolume, VolumeImportingError } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';
import { canEdit, MAX_PREVIEW_BYTES } from '@opfs-vfs/file-preview';
import type { MockFile, MockVolume } from './mock-state';
import { parentPath, within, leafPath, type FileOperation, type FileClipboard } from './mock-files';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Owned clients outlive the UI: application followers may already depend on them.
const retained = new Map<string, OpfsVfsWorker>();
type Connection = {
  client: OpfsVfsWorker;
  generation?: string;
  fs: InspectorFilesystem;
  writes: boolean;
  shellEnv?: Record<string, string>;
};
class InspectorFilesystem extends OpfsVfsJustBashAdapter {
  constructor(
    readonly client: OpfsVfsWorker,
    readonly permit: () => void,
  ) {
    super(client);
  }
  override async mv(from: string, to: string) {
    this.permit();
    await this.client.renameNoReplace(from, to);
  }
  override readFileBuffer(path: string) {
    return this.client.readFileBuffer(path, MAX_PREVIEW_BYTES);
  }
  override async writeFile(path: string, content: string | Uint8Array) {
    this.permit();
    await this.client.writeFileBuffer(
      path,
      typeof content === 'string' ? new TextEncoder().encode(content) : content.slice(),
    );
  }
  override async appendFile(path: string, content: string | Uint8Array) {
    this.permit();
    await this.client.writeFileBuffer(
      path,
      typeof content === 'string' ? new TextEncoder().encode(content) : content.slice(),
      { append: true },
    );
  }
}
const mutations = new Set(['writeFile', 'appendFile', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'symlink', 'link', 'utimes']);
export class DevtoolsSession {
  private connections = new Map<string, Connection>();
  private lost = new Set<string>();
  private disposed = false;
  private refreshTask?: Promise<MockVolume[]>;
  private busy = false;
  volumes: MockVolume[] = [];
  constructor() {
    for (const [name, client] of retained) this.add(name, client);
  }
  private add(name: string, client: OpfsVfsWorker, generation?: string) {
    const connection: Connection = { client, generation, writes: false, fs: undefined! };
    connection.fs = new InspectorFilesystem(client, () => this.requireWrites(name));
    this.connections.set(name, connection);
    this.lost.delete(name);
    return connection;
  }
  private dropConnection(name: string, c: Connection, unavailable = false) {
    c.writes = false;
    if (retained.get(name) === c.client) {
      if (!unavailable || c.client.disposed) {
        retained.delete(name);
        c.client.dispose();
      }
    } else c.client.dispose();
    this.connections.delete(name);
    if (unavailable) this.lost.delete(name);
    else this.lost.add(name);
  }
  setWrites(name: string, enabled: boolean) {
    const c = this.connections.get(name);
    if (c) c.writes = enabled;
  }
  cwd(name: string) {
    return this.connections.get(name)?.shellEnv?.PWD || '/';
  }
  private connection(name: string) {
    if (this.disposed) throw new Error('Devtools were unmounted.');
    const c = this.connections.get(name);
    if (!c) throw new Error('Connect this volume first.');
    return c;
  }
  private requireWrites(name: string) {
    const c = this.connection(name);
    if (!c.writes) throw new Error('Enable writes on this volume first.');
    return c;
  }
  async refresh(): Promise<MockVolume[]> {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.discover().finally(() => {
      this.refreshTask = undefined;
    });
    return this.refreshTask;
  }
  private async discover() {
    const root = await navigator.storage.getDirectory();
    const names = new Set<string>();
    const storageBytes = new Map<string, number | undefined>();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file') continue;
      const base = name.replace(
        /(?:\.meta\.[ab]|\.meta\.log|\.data\.log|\.crypt\.log|\.bin|\.bitmap|\.bootstrap|\.vault|\.crypt|\.importing|\.meta)$/,
        '',
      );
      if (base === name || !base) continue;
      const volume = `${base}.bin`;
      names.add(volume);
      if (!storageBytes.has(volume)) storageBytes.set(volume, 0);
      try {
        const bytes = (await handle.getFile()).size;
        const total = storageBytes.get(volume);
        if (total !== undefined) storageBytes.set(volume, total + bytes);
      } catch {
        // Never report a partial total when a backing file disappears or cannot be read.
        storageBytes.set(volume, undefined);
      }
    }
    for (const name of this.connections.keys()) names.add(name);
    const locks = await navigator.locks.query();
    const held = new Set(locks.held?.map((lock) => lock.name));
    const next: MockVolume[] = [];
    const unavailableNames = new Set<string>();
    for (const name of [...names].sort()) {
      if (this.disposed) break;
      let peek: Awaited<ReturnType<typeof peekVolume>> | undefined;
      let inspectionError: string | undefined;
      try {
        peek = await peekVolume(name);
      } catch (error) {
        inspectionError = message(error);
      }
      let c = this.connections.get(name);
      const unavailable = !peek || peek.importing;
      if (unavailable) unavailableNames.add(name);
      const client = retained.get(name);
      if (!c && !unavailable && client && !client.disposed) c = this.add(name, client);
      const owner =
        unavailable || (client && !client.disposed) ? undefined : await inspectWorker(name, { timeout: 120 });
      if (c && (unavailable || c.client.disposed || (c.generation && owner?.generation !== c.generation))) {
        this.dropConnection(name, c, unavailable);
        c = undefined;
      }
      const previous = this.volumes.find((v) => v.name === name);
      const protectedVolume = peek?.encrypted || peek?.compatible === false;
      // A headerless candidate is not proof of a VFS volume. Only a compatible owner can identify it.
      const busy = held.has(`opfs-vfs-volume-${name}`) || held.has(`opfs-vfs-lock-${name}`);
      next.push({
        name,
        state: unavailable
          ? 'busy'
          : protectedVolume
            ? 'protected'
            : this.lost.has(name)
              ? 'disconnected'
              : owner
                ? 'application'
                : busy || peek?.compatible !== true
                  ? 'busy'
                  : 'available',
        connection: c ? (c.generation ? 'passive' : 'owned') : 'none',
        error: inspectionError ?? (peek?.importing ? 'Import in progress or incomplete.' : undefined),
        storageBytes: storageBytes.get(name),
        files: unavailable ? [] : (previous?.files ?? []),
      });
    }
    if (!this.disposed)
      this.volumes = next.map((v) => ({
        ...v,
        files: unavailableNames.has(v.name)
          ? []
          : (this.volumes.find((current) => current.name === v.name)?.files ?? v.files),
      }));
    return this.volumes;
  }
  async connect(name: string) {
    const peek = await peekVolume(name);
    if (peek.importing) {
      const c = this.connections.get(name);
      if (c) this.dropConnection(name, c, true);
      this.volumes = this.volumes.map((v) =>
        v.name === name
          ? { ...v, state: 'busy', connection: 'none', error: 'Import in progress or incomplete.', files: [] }
          : v,
      );
      throw new VolumeImportingError(name);
    }
    if (this.connections.has(name)) return this.list(name);
    if (peek.encrypted || peek.compatible === false)
      throw new Error('Protected or incompatible volume. Open it with its application.');
    const retainedClient = retained.get(name);
    if (retainedClient && !retainedClient.disposed) {
      this.add(name, retainedClient);
      await this.refresh();
      return this.list(name);
    }
    const owner = await inspectWorker(name, { timeout: 300 });
    if (!owner && (!peek.exists || peek.compatible !== true))
      throw new Error('No compatible application owner or recognizable closed volume.');
    const client = new OpfsVfsWorker(
      name,
      owner ? { attachTo: owner.generation } : { claimIfAvailable: true, openMode: 'open-existing' },
    );
    try {
      await client.ready;
      if (this.disposed) {
        if (owner) client.dispose();
        else retained.set(name, client);
        throw new Error('Devtools were unmounted.');
      }
      this.add(name, client, owner?.generation);
      if (!owner) retained.set(name, client);
      await this.refresh();
      return await this.list(name);
    } catch (error) {
      if (!retained.has(name)) client.dispose();
      throw error;
    }
  }
  async list(name: string) {
    const c = this.connection(name);
    const paths = await c.client.listPaths();
    if (paths.length > 10000) throw new Error('This volume exceeds the 10,000-entry explorer limit.');
    const entries: MockFile[] = [];
    for (const path of paths) {
      if (path === '/') continue;
      const stat = await c.fs.lstat(path);
      entries.push({
        path,
        content: '',
        modified: stat.mtime.getTime(),
        size: stat.size,
        loaded: false,
        ...(stat.isDirectory ? { kind: 'directory' as const } : {}),
        symlink: stat.isSymbolicLink,
      });
    }
    this.volumes = this.volumes.map((v) => (v.name === name ? { ...v, files: entries } : v));
    return this.volumes;
  }
  async listDirectory(name: string, directory: string, signal: AbortSignal) {
    const c = this.connection(name);
    const entries: MockFile[] = [];
    const missing = (error: unknown) => (error as { code?: string }).code === 'ENOENT';
    let names: string[];
    try {
      names = await c.fs.readdir(directory);
    } catch (error) {
      if (!missing(error)) throw error;
      names = [];
    }
    if (names.length > 10000) throw new Error('This folder exceeds the 10,000-entry explorer limit.');
    for (const child of names) {
      if (signal.aborted) return this.volumes;
      const path = `${directory === '/' ? '' : directory}/${child}`;
      try {
        const stat = await c.fs.lstat(path);
        entries.push({
          path,
          content: '',
          modified: stat.mtime.getTime(),
          size: stat.size,
          loaded: false,
          ...(stat.isDirectory ? { kind: 'directory' as const } : {}),
          symlink: stat.isSymbolicLink,
        });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (signal.aborted || this.connections.get(name) !== c) return this.volumes;
    this.volumes = this.volumes.map((v) => {
      if (v.name !== name) return v;
      const previous = new Map(v.files.map((file) => [file.path, file]));
      const folders = new Set(entries.filter((file) => file.kind === 'directory').map((file) => file.path));
      const removed = v.files.filter(
        (file) => parentPath(file.path) === directory && file.kind === 'directory' && !folders.has(file.path),
      );
      return {
        ...v,
        files: [
          ...v.files.filter(
            (file) => parentPath(file.path) !== directory && !removed.some((folder) => within(folder.path, file.path)),
          ),
          ...entries.map((file) => {
            const old = previous.get(file.path);
            return old &&
              old.modified === file.modified &&
              old.size === file.size &&
              old.kind === file.kind &&
              !!old.symlink === !!file.symlink
              ? old
              : file;
          }),
        ],
      };
    });
    return this.volumes;
  }
  async read(name: string, path: string): Promise<MockFile> {
    const c = this.connection(name);
    const stat = await c.fs.lstat(path);
    if (stat.isSymbolicLink) throw new Error('Symbolic links are listed but not followed by file previews.');
    const bytes = await c.client.readFileBuffer(path, MAX_PREVIEW_BYTES);
    let file: MockFile = { path, content: '', bytes, modified: stat.mtime.getTime(), size: bytes.length, loaded: true };
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (canEdit({ path, content })) file = { ...file, content, bytes: undefined };
    } catch {
      /* Binary files keep their original bytes. */
    }
    this.volumes = this.volumes.map((v) =>
      v.name === name ? { ...v, files: v.files.map((f) => (f.path === path ? file : f)) } : v,
    );
    return file;
  }
  async save(name: string, file: MockFile, value: string) {
    const c = this.requireWrites(name);
    await c.client.writeFileBuffer(file.path, new TextEncoder().encode(value), {
      expected: new TextEncoder().encode(file.content),
    });
    await c.client.flush();
    this.volumes = this.volumes.map((v) =>
      v.name === name
        ? {
            ...v,
            files: v.files.map((f) =>
              f.path === file.path ? { ...f, content: value, size: new TextEncoder().encode(value).length } : f,
            ),
          }
        : v,
    );
  }
  async clipboard(name: string, path: string, cut: boolean): Promise<FileClipboard> {
    const c = this.connection(name);
    if (cut) this.requireWrites(name);
    await this.list(name);
    const entries = this.volumes.find((v) => v.name === name)!.files.filter((f) => within(path, f.path));
    if (!entries.some((f) => f.path === path)) throw new Error('Source no longer exists.');
    if (entries.length > 2000) throw new Error('Copy is limited to 2,000 entries.');
    let total = 0;
    const captured: MockFile[] = [];
    for (const entry of entries) {
      if (entry.symlink) throw new Error('Copying symbolic links is not supported.');
      if (entry.kind === 'directory') captured.push(entry);
      else {
        const bytes = await c.client.readFileBuffer(entry.path, MAX_PREVIEW_BYTES);
        total += bytes.length;
        if (total > 64 * 1024 * 1024) throw new Error('Copy is limited to 64 MiB total.');
        captured.push({ ...entry, bytes, loaded: true });
      }
    }
    return { volume: name, path, cut, entries: captured };
  }
  async mutate(name: string, op: FileOperation) {
    const c = this.requireWrites(name);
    if (op.kind === 'file' || op.kind === 'folder') {
      const path = leafPath(op.parent, op.name);
      if (op.kind === 'file') await c.client.writeFileBuffer(path, new Uint8Array(), { exclusive: true });
      else await c.client.mkdir(path);
    } else if (op.kind === 'rename') await c.client.renameNoReplace(op.path, leafPath(parentPath(op.path), op.name));
    else if (op.kind === 'delete') await c.client.remove(op.path);
    else if (op.kind === 'paste') {
      const clip = op.clipboard;
      const target = leafPath(op.parent, clip.path.split('/').at(-1)!);
      if (clip.volume === name && (target === clip.path || within(clip.path, op.parent)))
        throw new Error('Choose a different folder outside the source.');
      if (clip.cut) {
        if (clip.volume !== name)
          throw new Error('Cut and paste is supported within one volume. Use Copy between volumes.');
        this.requireWrites(clip.volume);
        await c.client.renameNoReplace(clip.path, target);
      } else {
        let written = 0;
        try {
          for (const entry of [...clip.entries].sort((a, b) => a.path.length - b.path.length)) {
            this.requireWrites(name);
            const dest = target + entry.path.slice(clip.path.length);
            if (entry.kind === 'directory') await c.client.mkdir(dest);
            else
              await c.client.writeFileBuffer(dest, entry.bytes?.slice() ?? new TextEncoder().encode(entry.content), {
                exclusive: true,
              });
            written++;
          }
        } catch (error) {
          throw new Error(`${message(error)}. ${written} entries copied; partial output is preserved.`);
        }
      }
    }
    await c.client.flush();
    return this.list(name);
  }
  async run(name: string, command: string) {
    const c = this.connection(name);
    const { Bash } = await import('just-bash');
    const fs = new Proxy(c.fs, {
      get: (target, key, receiver) => {
        if (key === 'getAllPaths')
          return () => this.volumes.find((v) => v.name === name)?.files.map((f) => f.path) ?? [];
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              if (mutations.has(String(key))) this.requireWrites(name);
              return value.apply(target, args);
            }
          : value;
      },
    });
    const bash = new Bash({
      fs: fs as unknown as IFileSystem,
      cwd: this.cwd(name),
      env: c.shellEnv,
      executionLimits: { maxCommandCount: 1000, maxLoopIterations: 1000, maxCallDepth: 50 },
    });
    const result = await bash.exec(command);
    // ponytail: just-bash exposes final cwd through PWD; use a dedicated cwd result if it adds one.
    c.shellEnv = result.env;
    await c.client.flush();
    await this.list(name);
    return result;
  }
  async create(name: string) {
    const client = new OpfsVfsWorker(name, { claimIfAvailable: true, openMode: 'create-new' });
    try {
      await client.ready;
    } catch (error) {
      client.dispose();
      throw error;
    }
    retained.set(name, client);
    this.add(name, client);
    await client.flush();
    return this.refresh();
  }
  async delete(name: string) {
    if (this.connections.has(name) || retained.has(name)) throw new Error('Connected volumes cannot be deleted.');
    await deleteVolume(name);
    return this.refresh();
  }
  async transfer(kind: 'import' | 'export', name: string, input?: File) {
    if (this.busy) throw new Error('A transfer is already running.');
    this.busy = true;
    try {
      const { importArchive, exportArchive } = await import('./archive');
      if (kind === 'import') {
        if (!input) throw new Error('Choose a ZIP file.');
        // Validate/decompress everything before creating a destination volume.
        const files = await importArchive(input);
        await this.create(name);
        const c = this.connection(name);
        let written = 0;
        try {
          for (const file of files) {
            if (file.directory) await c.client.mkdir(file.path);
            else await c.client.writeFileBuffer(file.path, file.bytes!, { exclusive: true });
            written++;
          }
          await c.client.flush();
        } catch (error) {
          throw new Error(
            `${message(error)}. Import stopped after ${written} entries. Partial volume ${name} remains.`,
          );
        }
        return this.list(name);
      }
      const blob = await exportArchive(this.connection(name).fs);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/\.bin$/, '')}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return this.volumes;
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    this.disposed = true;
    for (const c of this.connections.values()) {
      c.writes = false;
      if (c.generation) c.client.dispose();
    }
    this.connections.clear();
  }
}
