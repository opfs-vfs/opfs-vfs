import JSZip, { type JSZipObject } from 'jszip';
import type { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';

const ARCHIVE_LIMITS = { entries: 2_000, fileBytes: 16 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 } as const;
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

export async function exportArchive(fs: OpfsVfsJustBashAdapter) {
  const zip = new JSZip();
  const entries = (await fs.getAllPaths()).filter((path) => path !== '/');
  if (entries.length > ARCHIVE_LIMITS.entries) throw new Error('Export is limited to 2,000 entries.');
  let total = 0;
  for (const path of entries) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink) throw new Error(`Symbolic links cannot be exported: ${path}`);
    if (stat.isDirectory) zip.folder(path.slice(1));
    else {
      const bytes = await fs.readFileBuffer(path); // InspectorFilesystem enforces the bound in the worker.
      total += bytes.length;
      if (bytes.length > ARCHIVE_LIMITS.fileBytes || total > ARCHIVE_LIMITS.totalBytes)
        throw new Error('Export exceeds its size limit.');
      zip.file(path.slice(1), bytes);
    }
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('Export exceeds 128 MiB.');
  return blob;
}
export async function importArchive(input: Blob) {
  if (input.size > MAX_ARCHIVE_BYTES || input.size < 22) throw new Error('ZIP must be between 22 bytes and 128 MiB.');
  const bytes = new Uint8Array(await input.arrayBuffer());
  inspectZip(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const plan = new Map<string, { path: string; directory: boolean; bytes?: Uint8Array }>();
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const path = '/' + validateArchivePath(entry.name);
    if (plan.has(path) && !plan.get(path)!.directory) throw new Error(`Duplicate path: ${path}`);
    if (entry.dir) plan.set(path, { path, directory: true });
    else {
      if (plan.has(path)) throw new Error(`File/directory conflict: ${path}`);
      const data = await readEntry(entry, Math.min(ARCHIVE_LIMITS.fileBytes, ARCHIVE_LIMITS.totalBytes - total));
      total += data.length;
      plan.set(path, { path, directory: false, bytes: data });
    }
  }
  for (const { path } of [...plan.values()]) {
    const parts = path.slice(1).split('/');
    parts.pop();
    let ancestor = '';
    for (const part of parts) {
      ancestor += '/' + part;
      if (plan.has(ancestor) && !plan.get(ancestor)!.directory) throw new Error(`File/directory conflict: ${ancestor}`);
      plan.set(ancestor, { path: ancestor, directory: true });
    }
  }
  if (plan.size > ARCHIVE_LIMITS.entries) throw new Error('Import is limited to 2,000 entries including folders.');
  return [...plan.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
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
