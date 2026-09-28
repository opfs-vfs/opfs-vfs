import JSZip, { type JSZipObject } from 'jszip';
import type { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';
import { listTree } from './filesystem';

const ARCHIVE_LIMITS = { entries: 2_000, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 } as const;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export function validateArchivePath(input: string) {
  if (!input || input.includes('\0') || input.includes('\\') || input.startsWith('/') || /^[a-z]:/i.test(input))
    throw new Error(`Unsafe archive path: ${input}`);
  const normalized = input
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  if (!normalized || input.split('/').includes('..')) throw new Error(`Unsafe archive path: ${input}`);
  return normalized;
}

function inspectZip(input: Uint8Array) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let eocd = input.length - 22;
  const lowerBound = Math.max(0, input.length - 65_557);
  while (eocd >= lowerBound && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  if (eocd < lowerBound || view.getUint32(eocd, true) !== 0x06054b50) throw new Error('ZIP end record is missing');
  const count = view.getUint16(eocd + 10, true);
  if (count === 0xffff) throw new Error('ZIP64 archives are not supported');
  if (count > ARCHIVE_LIMITS.entries) throw new Error(`Archive has more than ${ARCHIVE_LIMITS.entries} entries`);
  let offset = view.getUint32(eocd + 16, true);
  let total = 0;
  const paths = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    if (offset < 0 || offset + 46 > input.length) throw new Error('Malformed ZIP directory');
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Malformed ZIP directory');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const attrs = view.getUint32(offset + 38, true);
    if (offset + 46 + nameLength + extraLength + commentLength > input.length)
      throw new Error('Malformed ZIP directory');
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : undefined).decode(
      input.subarray(offset + 46, offset + 46 + nameLength),
    );
    const path = validateArchivePath(name);
    if (paths.has(path)) throw new Error(`Duplicate archive path: ${path}`);
    paths.add(path);
    if (![0, 8].includes(method)) throw new Error(`Unsupported ZIP compression for ${path}`);
    if (flags & 1) throw new Error(`Encrypted ZIP entries are not supported: ${path}`);
    if (((attrs >>> 16) & 0xf000) === 0xa000) throw new Error(`Symbolic links are not supported: ${path}`);
    if (size > ARCHIVE_LIMITS.fileBytes) throw new Error(`${path} exceeds the per-file limit`);
    total += size;
    if (total > ARCHIVE_LIMITS.totalBytes) throw new Error('Archive exceeds the expanded-size limit');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

export async function exportWorkspace(fs: OpfsVfsJustBashAdapter) {
  const zip = new JSZip();
  const entries = await listTree(fs);
  if (entries.length - 1 > ARCHIVE_LIMITS.entries)
    throw new Error(`Workspace has more than ${ARCHIVE_LIMITS.entries} entries`);
  let total = 0;
  for (const entry of entries) {
    if (entry.path === '/workspace') continue;
    const path = entry.path.slice('/workspace/'.length);
    const stat = await fs.lstat(entry.path);
    if (stat.isSymbolicLink) throw new Error(`Symbolic links cannot be exported: ${path}`);
    if (entry.kind === 'directory') zip.folder(path);
    else {
      if (stat.size > ARCHIVE_LIMITS.fileBytes) throw new Error(`${path} exceeds the per-file export limit`);
      total += stat.size;
      if (total > ARCHIVE_LIMITS.totalBytes) throw new Error('Workspace exceeds the expanded export-size limit');
      zip.file(path, await fs.readFileBuffer(entry.path));
    }
  }
  const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  if (archive.size > MAX_ARCHIVE_BYTES) throw new Error('Export exceeds the 128 MB compressed-size limit');
  return archive;
}

export async function importWorkspace(fs: OpfsVfsJustBashAdapter, input: Blob) {
  if (input.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP exceeds the 128 MB compressed-size limit');
  const archiveBytes = new Uint8Array(await input.arrayBuffer());
  inspectZip(archiveBytes);
  const zip = await JSZip.loadAsync(archiveBytes);
  const entries = Object.values(zip.files);
  if (entries.length > ARCHIVE_LIMITS.entries)
    throw new Error(`Archive has more than ${ARCHIVE_LIMITS.entries} entries`);
  const seen = new Set<string>();
  let total = 0;
  const directories: string[] = [];
  const files: Array<{ bytes: Uint8Array; path: string }> = [];
  for (const entry of entries) {
    const path = validateArchivePath(entry.name);
    if (seen.has(path)) throw new Error(`Duplicate archive path: ${path}`);
    seen.add(path);
    if (entry.dir) {
      directories.push(`/workspace/${path}`);
      continue;
    }
    const bytes = await readEntry(entry, Math.min(ARCHIVE_LIMITS.fileBytes, ARCHIVE_LIMITS.totalBytes - total));
    if (bytes.length > ARCHIVE_LIMITS.fileBytes) throw new Error(`${path} exceeds the per-file limit`);
    total += bytes.length;
    if (total > ARCHIVE_LIMITS.totalBytes) throw new Error('Archive exceeds the expanded-size limit');
    files.push({ bytes, path: `/workspace/${path}` });
  }
  for (const file of files) if (await fs.exists(file.path)) throw new Error(`${file.path} already exists`);
  for (const directory of directories.sort((a, b) => a.length - b.length))
    await fs.mkdir(directory, { recursive: true });
  for (const file of files) {
    await fs.mkdir(file.path.slice(0, file.path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(file.path, file.bytes);
  }
  return files.length;
}

function readEntry(entry: JSZipObject, limit: number) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stream = (
      entry as unknown as {
        internalStream(type: string): {
          on(event: string, handler: (value: unknown) => void): void;
          pause(): void;
          resume(): void;
        };
      }
    ).internalStream('uint8array');
    stream.on('data', (value) => {
      const chunk = value as Uint8Array;
      size += chunk.length;
      if (size > limit) {
        stream.pause();
        reject(new Error(`${entry.name} exceeds the expanded-size limit`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(bytes);
    });
    stream.resume();
  });
}
