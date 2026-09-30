import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, FileSystem } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { expect, it } from 'vitest';
import { runFilesystemContract } from '../src/filesystem-contract.js';

it('runs the shared filesystem contract against pinned NodeFileSystem', async () => {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'opfs-vfs-effect-contract-')));
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* runFilesystemContract(fs, {
            root: temporaryRoot,
            path: (...parts) => join(temporaryRoot, ...parts),
          });
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    expect(result.directoryListing).toContain('nested/payload.bin');
    expect(result.directLinkTarget).toBe('nested/payload.bin');
    expect(result.realPathMatches).toBe(true);
    expect(result.copiedFileMatches).toBe(true);
    expect(result.copiedTreeMatches).toBe(true);
    expect(result.copyFilePreservedLink).toBe(true);
    expect(result.copyFileCopiedTarget).toBe(true);
    expect(result.writeInputRetained).toBe(true);
    expect(result.fileWriteInputRetained).toBe(true);
    expect(result.copiedLinkTarget).toBe(join(temporaryRoot, 'tree', 'nested', 'payload.bin'));
    expect(result.overwriteReplacedLink).toBe(true);
    expect(result.overwritePreservedTarget).toBe(true);
    expect(result.overwriteCopiedContents).toBe(true);
    expect(result.times).toEqual({ atimeMs: 1234, mtimeMs: 5000 });
    expect(result.stat).toEqual({ type: 'File', size: 7n });
    expect(result.temps).toMatchObject({
      directoryExistsInScope: true,
      directoryRemoved: true,
      directoryPrefix: true,
      directoryParentIsRoot: true,
      fileExistsInScope: true,
      fileRemoved: true,
      fileParentIsRoot: true,
      fileParentPrefix: true,
      fileBasenameExcludesPrefix: true,
      fileSuffix: true,
    });
    expect(result.file).toEqual({
      bytesRead: 2,
      initial: [10, 20],
      positionAfterRead: 2n,
      bytesWritten: 1,
      contents: [10, 20, 99, 40],
      size: 4n,
    });
    expect(['baseAB', 'baseBA']).toContain(result.concurrentAppend);
    expect(result.largeAppend).toEqual({
      size: 16n * 1024n * 1024n + 3n,
      prefixMatches: true,
      finalBytesRead: 3,
      finalBytes: [0x70, 0x71, 0x72],
      originalLength: 16 * 1024 * 1024,
      inputRetained: true,
    });
    expect(result.stream).toEqual({ size: 256 * 1024, matches: true });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}, 65_000);
