// Throwaway fixture model. It never imports VFS or opens storage.
export type Dock = 'floating' | 'left' | 'right' | 'top' | 'bottom';
export type MockFile = {
  path: string;
  content: string;
  bytes?: Uint8Array;
  kind?: 'directory';
  modified: number;
  size?: number;
  loaded?: boolean;
  symlink?: boolean;
  error?: string;
};
export type MockVolume = {
  name: string;
  state: 'application' | 'available' | 'busy' | 'protected' | 'disconnected';
  connection: 'none' | 'passive' | 'owned';
  /** Sum of backing-file lengths at discovery; undefined when unavailable. */
  storageBytes?: number;
  error?: string;
  files: MockFile[];
};
export type Rect = { x: number; y: number; width: number; height: number };

export function connect(volume: MockVolume): MockVolume {
  if (volume.connection !== 'none') return volume;
  if (volume.state === 'application') return { ...volume, connection: 'passive' };
  if (volume.state === 'available') return { ...volume, connection: 'owned' };
  return volume;
}
export function canDelete(volume: MockVolume): boolean {
  return volume.state === 'available' && volume.connection === 'none';
}
export function filterFiles(files: MockFile[], search: string, sort: string): MockFile[] {
  const bytes = (file: MockFile) =>
    file.size ?? file.bytes?.byteLength ?? new TextEncoder().encode(file.content).length;
  return files
    .filter((entry) => entry.path.toLowerCase().includes(search.toLowerCase()))
    .sort(
      (a, b) =>
        (sort === 'size' ? bytes(b) - bytes(a) : sort === 'modified' ? b.modified - a.modified : 0) ||
        a.path.localeCompare(b.path),
    );
}
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const w = Math.min(Math.max(320, rect.width), width - 24);
  const h = Math.min(Math.max(320, rect.height), height - 24);
  return {
    width: w,
    height: h,
    x: Math.max(12, Math.min(rect.x, width - w - 12)),
    y: Math.max(12, Math.min(rect.y, height - h - 12)),
  };
}
