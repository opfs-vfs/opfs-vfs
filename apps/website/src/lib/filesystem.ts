import type { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';

export type ExplorerEntry = { kind: 'directory' | 'file'; name: string; path: string; size: number };
export type DroppedFiles = { entries: FileSystemEntry[]; files: File[] };

export async function listTree(fs: OpfsVfsJustBashAdapter, root = '/workspace'): Promise<ExplorerEntry[]> {
  const entries: ExplorerEntry[] = [{ kind: 'directory', name: root.slice(1), path: root, size: 0 }];
  const visit = async (directory: string) => {
    for (const item of await fs.readdirWithFileTypes(directory)) {
      const path = `${directory}/${item.name}`;
      const stat = await fs.lstat(path);
      const kind = stat.isDirectory && !stat.isSymbolicLink ? 'directory' : 'file';
      entries.push({ kind, name: item.name, path, size: stat.size });
      if (kind === 'directory') await visit(path);
    }
  };
  await visit(root);
  return entries;
}

export function captureDroppedFiles(transfer: DataTransfer): DroppedFiles {
  return {
    entries: Array.from(transfer.items, (item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry =>
      Boolean(entry),
    ),
    files: Array.from(transfer.files),
  };
}

export async function importDroppedFiles(fs: OpfsVfsJustBashAdapter, dropped: DroppedFiles, directory: string) {
  const files: Array<{ file: File; path: string }> = [];
  const walk = async (entry: FileSystemEntry, parent: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, path: `${parent}/${file.name}` });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      children.push(...batch);
    }
    const next = `${parent}/${entry.name}`;
    await fs.mkdir(next, { recursive: true });
    for (const child of children) await walk(child, next);
  };
  for (const entry of dropped.entries) await walk(entry, directory);
  if (!files.length) {
    for (const file of dropped.files) {
      const relative = file.webkitRelativePath || file.name;
      const parts = relative.split('/');
      if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
        throw new Error(`Unsafe dropped path: ${relative}`);
      files.push({ file, path: `${directory}/${parts.join('/')}` });
    }
  }
  for (const item of files) {
    if (await fs.exists(item.path)) throw new Error(`${item.path} already exists`);
    await fs.writeFile(item.path, new Uint8Array(await item.file.arrayBuffer()));
  }
  return files.length;
}
