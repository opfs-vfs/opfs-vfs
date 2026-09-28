import type { FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import { subscribe, type Subscription } from '@opfs-vfs/plugin-subscriptions/client';

type CurrentViewFs = FileChangeSource & {
  lstat(path: string): Promise<{ is_dir: boolean; is_file: boolean }>;
  readdir(path: string): Promise<string[]>;
  readFileBuffer(path: string): Promise<Uint8Array>;
};

type CurrentViewOptions = {
  root: string;
  maxPending?: number;
  content?: false | { maxBytes: number };
  onError: (cause: unknown) => void | Promise<void>;
};

export type CurrentViewAttempt = {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly ready: Promise<void>;
  stop(): void;
  restart(): Promise<CurrentViewAttempt>;
};

const missing = (cause: unknown) => (cause as { code?: unknown }).code === 'ENOENT';
const child = (parent: string, path: string) =>
  parent === '/' ? path.startsWith('/') && path !== '/' : path.startsWith(`${parent}/`);
const join = (parent: string, name: string) => (parent === '/' ? `/${name}` : `${parent}/${name}`);
const canonicalRoot = (path: string) => {
  if (!path || path.includes('\0')) throw new RangeError('root must be a nonempty path');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
};

/**
 * Application-side current-view recovery. Register before scanning; change payloads
 * are invalidations only, so every value below comes from a current filesystem read.
 */
export async function startCurrentView(
  fs: CurrentViewFs,
  { root, maxPending = 1024, content = false, onError }: CurrentViewOptions,
): Promise<CurrentViewAttempt> {
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0) throw new RangeError('maxPending must be positive');
  const watchedRoot = canonicalRoot(root);
  const files = new Map<string, Uint8Array>();
  const pending = new Set<string>();
  let active = true;
  let scanning = true;
  let subscription: Subscription | undefined;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (cause: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      readySettled = true;
      resolve();
    };
    rejectReady = (cause) => {
      readySettled = true;
      reject(cause);
    };
  });
  void ready.catch(() => {}); // A stopped attempt may never have a ready() waiter.
  const stopped = (cause: unknown, report = true) => {
    if (!active) return;
    active = false;
    subscription?.unsubscribe();
    if (!readySettled) rejectReady(cause);
    files.clear();
    pending.clear();
    if (report)
      try {
        void Promise.resolve(onError(cause)).catch(() => {});
      } catch {
        // Application error reporting must not create an unhandled updater rejection.
      }
  };
  const check = () => {
    if (!active) throw new Error('Current view attempt was abandoned');
  };
  const remove = (path: string) => {
    files.delete(path);
    for (const known of [...files.keys()]) if (child(path, known)) files.delete(known);
  };
  const read = async (path: string): Promise<Map<string, Uint8Array>> => {
    const next = new Map<string, Uint8Array>();
    let stat: { is_dir: boolean; is_file: boolean };
    try {
      stat = await fs.lstat(path);
      check();
    } catch (cause) {
      check();
      if (missing(cause)) return next;
      throw cause;
    }
    if (stat.is_dir) {
      let names: string[];
      try {
        names = await fs.readdir(path);
        check();
      } catch (cause) {
        check();
        if (missing(cause)) return next;
        throw cause;
      }
      for (const name of names) {
        if (name === '.' || name === '..') continue;
        for (const [childPath, bytes] of await read(join(path, name))) next.set(childPath, bytes);
        check();
      }
      return next;
    }
    if (!stat.is_file) return next; // Do not follow symlinks while reconstructing a directory tree.
    try {
      const bytes = await fs.readFileBuffer(path);
      check();
      next.set(path, bytes);
    } catch (cause) {
      check();
      if (!missing(cause)) throw cause;
    }
    return next;
  };
  const reread = async (path: string): Promise<void> => {
    const next = await read(path);
    check();
    remove(path);
    for (const [nextPath, bytes] of next) files.set(nextPath, bytes);
  };
  let pump: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (pump) return pump;
    pump = Promise.resolve().then(async () => {
      try {
        while (active && pending.size) {
          const path = pending.values().next().value as string;
          pending.delete(path); // A later event during this read must add it again.
          await reread(path);
          check();
        }
      } catch (cause) {
        stopped(cause);
      } finally {
        pump = undefined;
      }
    });
    return pump;
  };
  subscription = await subscribe(
    fs,
    {
      path: watchedRoot,
      scope: 'directory',
      recursive: true,
      content,
      onError: stopped,
    },
    (change) => {
      if (!active) return;
      pending.add(change.path);
      if (pending.size > maxPending) stopped(new Error('Current view pending-path bound exceeded'));
      else if (!scanning) void drain();
    },
  );
  void (async () => {
    try {
      await reread(watchedRoot);
      check();
      scanning = false;
      await drain();
      check();
      resolveReady();
    } catch (cause) {
      stopped(cause);
    }
  })();
  return {
    files,
    ready,
    stop() {
      stopped(new Error('Current view stopped'), false);
    },
    restart() {
      const previous = subscription!;
      stopped(new Error('Current view restarted'), false);
      return previous.closed.then((retirement) => {
        if (retirement.status === 'unknown') throw retirement.error;
        return startCurrentView(fs, { root: watchedRoot, maxPending, content, onError });
      });
    },
  };
}
