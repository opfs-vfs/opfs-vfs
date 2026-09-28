import { useCallback, useEffect, useMemo, useSyncExternalStore, useState, type ReactNode } from 'react';
import { configurationError, VolumeError } from './errors';
import { useVolumeBinding, type VolumeName } from './volume';
import type {
  FileContentResult,
  FileInfo,
  FileResult,
  FolderResult,
  FolderEntry,
  ResourceEntry,
  ResourceKind,
  ResourceResult,
  ResourceValue,
} from './resources';
import { MAX_CONTENT_BYTES } from './resources';

const idle = Object.freeze({
  status: 'idle' as const,
  data: undefined,
  error: null,
  isRefreshing: false as const,
  isStale: false as const,
  refresh: () => Promise.resolve(),
});
const pending = Object.freeze({ ...idle, status: 'pending' as const });

export type ReadOptions = Readonly<{ volume?: VolumeName; enabled?: boolean }>;
export type FileContentOptions = ReadOptions &
  Readonly<{
    format?: 'bytes' | 'text';
    limit?: number;
  }>;

function useResource<T extends ResourceValue>(
  kind: ResourceKind,
  path: string,
  limit: number,
  options: ReadOptions,
): ResourceResult<T> {
  const binding = useVolumeBinding(options.volume);
  const volume = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getServerSnapshot);
  const target = binding.resourceStore();
  const store = target?.store ?? null;
  const ownerGeneration = target?.ownerGeneration ?? null;
  const enabled = options.enabled !== false;
  const [held, setHeld] = useState<{
    binding: typeof binding;
    store: NonNullable<typeof store>;
    entry: ResourceEntry<T>;
  } | null>(null);
  const current =
    held?.binding === binding &&
    held.store === store &&
    held.entry &&
    enabled &&
    held.entry.kind === kind &&
    held.entry.path === path &&
    held.entry.limit === limit &&
    held.entry.ownerGeneration === ownerGeneration
      ? held.entry
      : null;

  useEffect(() => {
    if (!enabled || !store || !ownerGeneration) return;
    const next = store.acquire<T>(ownerGeneration, kind, path, limit);
    setHeld({ binding, store, entry: next });
    return () => store.release(next);
  }, [binding, enabled, kind, limit, ownerGeneration, path, store]);

  useEffect(() => {
    if (!current || !store) return;
    return store.reportFailures(current, binding, (error) => binding.report(error));
  }, [binding, current, store]);

  const subscribe = useCallback(
    (listener: () => void) => (current && store ? store.subscribe(current, listener) : () => {}),
    [current, store],
  );
  const fallback = useMemo(
    () => readFallback<T>(volume.status, volume.error, enabled),
    [enabled, volume.error, volume.status],
  );
  const snapshot = useCallback(() => current?.snapshot ?? fallback, [current, fallback]);
  return useSyncExternalStore(subscribe, snapshot, () =>
    enabled ? (pending as ResourceResult<T>) : (idle as ResourceResult<T>),
  );
}

function readFallback<T extends ResourceValue>(
  status: 'pending' | 'ready' | 'recovering' | 'unsupported' | 'error' | 'closed',
  error: VolumeError | null,
  enabled: boolean,
): ResourceResult<T> {
  if (!enabled) return idle as ResourceResult<T>;
  if (status === 'pending' || status === 'ready' || status === 'recovering') return pending as ResourceResult<T>;
  return Object.freeze({
    status: 'error' as const,
    data: undefined,
    error:
      error ??
      new VolumeError({
        kind: 'lifecycle',
        operation: 'read',
        volume: null,
        outcome: 'unknown',
        message: `Volume is ${status}`,
      }),
    isRefreshing: false,
    isStale: false,
    refresh: () => Promise.resolve(),
  });
}

function validatePath(path: string) {
  if (typeof path !== 'string' || !path.startsWith('/'))
    throw configurationError('read', null, 'Resource path must be absolute');
}

/** Returns a live directory listing after the selected provider has committed. */
export function useFolder(path: string, options: ReadOptions = {}): FolderResult {
  validatePath(path);
  return useResource<readonly FolderEntry[]>('folder', path, MAX_CONTENT_BYTES, options);
}

/** Returns live metadata for an ordinary file, or null when it is absent. */
export function useFile(path: string, options: ReadOptions = {}): FileResult {
  validatePath(path);
  return useResource<FileInfo | null>('file', path, MAX_CONTENT_BYTES, options);
}

export function useFileContent(
  path: string,
  options?: ReadOptions & { format?: 'bytes'; limit?: number },
): FileContentResult<Uint8Array>;
export function useFileContent(
  path: string,
  options: ReadOptions & { format: 'text'; limit?: number },
): FileContentResult<string>;
export function useFileContent(
  path: string,
  options: FileContentOptions,
): FileContentResult<Uint8Array> | FileContentResult<string>;
/** Returns live whole-file content, bounded to 16 MiB before optional UTF-8 decoding. */
export function useFileContent(
  path: string,
  options: FileContentOptions = {},
): FileContentResult<Uint8Array> | FileContentResult<string> {
  validatePath(path);
  const limit = options.limit ?? MAX_CONTENT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CONTENT_BYTES)
    throw configurationError('readFileBuffer', null, 'Invalid content limit');
  if (options.format !== undefined && options.format !== 'bytes' && options.format !== 'text')
    throw configurationError('readFileBuffer', null, 'Invalid content format');
  const result = useResource<Uint8Array | string | null>(
    options.format === 'text' ? 'content-text' : 'content-bytes',
    path,
    limit,
    options,
  );
  return result as FileContentResult<Uint8Array> | FileContentResult<string>;
}

export type FolderProps = ReadOptions & Readonly<{ path: string; children: (result: FolderResult) => ReactNode }>;
export type FileProps = ReadOptions & Readonly<{ path: string; children: (result: FileResult) => ReactNode }>;
type FileContentBase = Readonly<{
  path: string;
}> &
  ReadOptions &
  Readonly<{ limit?: number }>;
export type FileContentProps =
  | (FileContentBase & Readonly<{ format?: 'bytes'; children: (result: FileContentResult<Uint8Array>) => ReactNode }>)
  | (FileContentBase & Readonly<{ format: 'text'; children: (result: FileContentResult<string>) => ReactNode }>);

export function Folder({ path, children, ...options }: FolderProps): ReactNode {
  return children(useFolder(path, options));
}

export function File({ path, children, ...options }: FileProps): ReactNode {
  return children(useFile(path, options));
}

export function FileContent(props: FileContentProps): ReactNode {
  const { path, children, ...options } = props;
  return children(useFileContent(path, options) as never);
}
