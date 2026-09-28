import type { MockFile, MockVolume } from './mock-state.ts';
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
export const within = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
export type FileClipboard = { volume: string; path: string; cut: boolean; entries: MockFile[] };
export type FileOperation =
  | { kind: 'file' | 'folder'; parent: string; name: string }
  | { kind: 'rename'; path: string; name: string }
  | { kind: 'delete'; path: string }
  | { kind: 'paste'; parent: string; clipboard: FileClipboard };
export const writableVolume = (volume: MockVolume | undefined, writes: Record<string, boolean>) =>
  !!volume && (volume.connection === 'owned' || (volume.connection === 'passive' && !!writes[volume.name]));
const clone = (entry: MockFile) => ({ ...entry, bytes: entry.bytes?.slice() });
export function leafPath(parent: string, name: string) {
  if (
    !name.trim() ||
    name !== name.trim() ||
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    /\p{Cc}/u.test(name)
  )
    throw new Error('Enter one filename without slashes or control characters.');
  return `${parent === '/' ? '' : parent}/${name}`;
}
function requireDirectory(volume: MockVolume, path: string) {
  if (path !== '/' && !volume.files.some((f) => f.path === path && f.kind === 'directory'))
    throw new Error('The destination folder is no longer available.');
}
export function captureClipboard(volume: MockVolume, path: string, cut: boolean): FileClipboard {
  const entries = volume.files.filter((f) => within(path, f.path));
  if (!entries.some((f) => f.path === path)) throw new Error('The selected entry is no longer available.');
  return { volume: volume.name, path, cut, entries: entries.map(clone) };
}
export function applyFileOperation(
  volumes: MockVolume[],
  volumeName: string,
  operation: FileOperation,
  writes: Record<string, boolean>,
): MockVolume[] {
  const target = volumes.find((v) => v.name === volumeName);
  if (!writableVolume(target, writes) || !target)
    throw new Error('Enable writes on the connected destination volume first.');
  let entries = target.files;
  let sourceVolume = '';
  let sourcePath = '';
  if (operation.kind === 'file' || operation.kind === 'folder') {
    requireDirectory(target, operation.parent);
    const path = leafPath(operation.parent, operation.name);
    if (entries.some((f) => within(path, f.path))) throw new Error('That name is already in use.');
    entries = [
      ...entries,
      {
        path,
        content: '',
        modified: Date.now(),
        ...(operation.kind === 'folder' ? { kind: 'directory' as const } : {}),
      },
    ];
  } else if (operation.kind === 'delete' || operation.kind === 'rename') {
    if (!entries.some((f) => f.path === operation.path)) throw new Error('The selected entry is no longer available.');
    if (operation.kind === 'delete') entries = entries.filter((f) => !within(operation.path, f.path));
    else {
      const path = leafPath(parentPath(operation.path), operation.name);
      if (path === operation.path) return volumes;
      if (entries.some((f) => within(path, f.path))) throw new Error('That name is already in use.');
      entries = entries.map((f) =>
        within(operation.path, f.path) ? { ...f, path: path + f.path.slice(operation.path.length) } : f,
      );
    }
  } else if (operation.kind === 'paste') {
    requireDirectory(target, operation.parent);
    const clip = operation.clipboard;
    const path = leafPath(operation.parent, clip.path.split('/').at(-1)!);
    if (clip.volume === volumeName && (path === clip.path || within(clip.path, operation.parent)))
      throw new Error('Choose a different folder outside the copied entry.');
    if (entries.some((f) => within(path, f.path)))
      throw new Error('That name is already in use. Nothing was replaced.');
    if (clip.cut) {
      const source = volumes.find((v) => v.name === clip.volume);
      if (!writableVolume(source, writes) || !source)
        throw new Error('The cut source must still be connected with writes enabled.');
      const current = captureClipboard(source, clip.path, true);
      if (JSON.stringify(current.entries) !== JSON.stringify(clip.entries))
        throw new Error('The cut source changed. Cut it again before moving.');
      sourceVolume = clip.volume;
      sourcePath = clip.path;
    }
    entries = [...entries, ...clip.entries.map((f) => ({ ...clone(f), path: path + f.path.slice(clip.path.length) }))];
  }
  return volumes.map((v) => {
    const files = v.name === volumeName ? entries : v.files;
    return { ...v, files: v.name === sourceVolume ? files.filter((f) => !within(sourcePath, f.path)) : files };
  });
}
