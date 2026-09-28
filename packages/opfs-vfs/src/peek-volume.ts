/** Read-only volume inspection using async getFile(), safe on the main thread.
 * Core reports plaintext metadata versions and reserved protection-marker presence.
 * Protected payloads remain opaque; compatibility is unknown until their storage
 * extension mounts them. A compatible header does not guarantee a successful mount.
 */

import { CURRENT_BINARY_VERSION } from './binary-metadata';
import { findVolumeFile, isNotFound, volumeFileNames } from './volume-files';

// Snapshot/metadata magics aren't part of the public crypto format module, so we
// keep local copies for parsing. A mismatch just yields `undefined`/`unknown`
// (safe) — these are parse helpers, not a contract.
const SNAPSHOT_MAGIC = 0x534e4150; // 'SNAP' — meta snapshot envelope
const BVFS_MAGIC = 0x42564653; // 'BVFS' — inner metadata header
const SNAPSHOT_HEADER_SIZE = 32; // envelope: magic|seq|crc|len|physicalDataSize|logicalExtent

export interface VolumePeek {
  /** Volume base name as passed in (e.g. "app.bin"). */
  name: string;
  /** Any sidecar present? `false` ⇒ a fresh volume would be created on open. */
  exists: boolean;
  /** A `.vault` exists, possibly damaged. This does not prove it can be unlocked. */
  encrypted: boolean;
  /** An unfinished import reservation exists, even if its marker is damaged. */
  importing: boolean;
  /**
   * Inner BVFS metadata version. Present for PLAINTEXT volumes; `undefined` for
   * encrypted volumes (the snapshot payload is sealed — read it at mount instead).
   */
  metadataVersion?: number;
  /**
   * Compatibility with THIS build:
   *  - `true`  — every version we could read matches current.
   *  - `false` — at least one read version differs ⇒ reset/migration needed.
   *  - `'unknown'` — encrypted volume whose deciding metadata version is sealed;
   *    open with the key and rely on the `format-version` error.
   */
  compatible: boolean | 'unknown';
  /** The current versions this build writes/accepts (for display / comparison). */
  current: { metadata: number };
}

function baseName(name: string): string {
  return name.replace(/\.bin$/, '');
}

async function readSidecar(
  root: FileSystemDirectoryHandle,
  fileName: string,
  maxBytes: number,
): Promise<DataView | null> {
  try {
    const fh = await root.getFileHandle(fileName, { create: false });
    const file = await fh.getFile();
    const buf = await file.slice(0, Math.min(maxBytes, file.size)).arrayBuffer();
    return new DataView(buf);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

/**
 * Inspect a volume's on-disk headers without opening it. Never throws for a
 * missing/absent volume (returns `exists: false`); never needs a key. OPFS access
 * and lookup failures other than NotFoundError propagate. Names must end in .bin.
 */
export async function peekVolume(name: string): Promise<VolumePeek> {
  const files = volumeFileNames(name);
  const base = baseName(name);
  const current = {
    metadata: CURRENT_BINARY_VERSION,
  };
  const result: VolumePeek = {
    name,
    exists: false,
    encrypted: false,
    importing: false,
    compatible: 'unknown',
    current,
  };

  const root = await navigator.storage.getDirectory();

  // Reserved extension files require an appropriate storage implementation.
  result.encrypted =
    (await findVolumeFile(
      root,
      ['.vault', '.crypt', '.crypt.log'].map((suffix) => `${base}${suffix}`),
    )) !== undefined;
  result.importing = (await findVolumeFile(root, [`${base}.importing`])) !== undefined;
  result.exists = result.encrypted || result.importing;

  // ── data file presence (covers plaintext volumes with no vault) ──
  // ── metadata snapshot version: readable only when the payload is plaintext ──
  // Prefer .meta.a; fall back to .meta.b. The version sits at the BVFS header's
  // offset 4, which is SNAPSHOT_HEADER_SIZE into the payload.
  for (const suffix of ['.meta.a', '.meta.b']) {
    const snap = await readSidecar(root, `${base}${suffix}`, SNAPSHOT_HEADER_SIZE + 8);
    if (!snap) continue;
    result.exists = true;
    if (snap.byteLength < SNAPSHOT_HEADER_SIZE + 8) continue;
    if (snap.getUint32(0, true) !== SNAPSHOT_MAGIC) continue; // not a snapshot envelope
    // Inner BVFS header begins after the 32-byte envelope. If its magic is the
    // plaintext BVFS magic, the payload is unencrypted and the version is readable.
    if (!result.encrypted && snap.getUint32(SNAPSHOT_HEADER_SIZE, true) === BVFS_MAGIC) {
      result.metadataVersion = snap.getUint32(SNAPSHOT_HEADER_SIZE + 4, true);
      break;
    }
    // Otherwise the payload is sealed (encrypted volume) → leave metadataVersion
    // undefined; the .bin presence still proves existence.
  }

  // Any remaining component, even empty or unrecognized, proves existence.
  if (!result.exists) {
    result.exists = (await findVolumeFile(root, files)) !== undefined;
  }

  // ── compatibility verdict ──
  result.compatible = computeCompatible(result);
  return result;
}

function computeCompatible(p: VolumePeek): boolean | 'unknown' {
  if (!p.exists) return true; // nothing on disk → a fresh, current-format volume will be made
  if (p.importing) return 'unknown';
  // Any readable version that differs from current ⇒ incompatible (reset needed).
  if (p.encrypted) return 'unknown';
  // Plaintext volume: the metadata version IS the deciding, readable version.
  if (p.metadataVersion !== undefined) return p.metadataVersion === p.current.metadata;
  return 'unknown'; // exists but no readable snapshot (e.g. pre-first-commit) — open to find out
}
