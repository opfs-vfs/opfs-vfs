import { ByteSize, Effect, Option, PlatformError, Scope, Stream } from 'effect';
import type { FileSystem } from 'effect/FileSystem';

export interface FileSystemContractFixture {
  readonly root: string;
  readonly path: (...parts: ReadonlyArray<string>) => string;
}

export interface FileSystemContractResult {
  readonly directoryListing: ReadonlyArray<string>;
  readonly directLinkTarget: string;
  readonly copiedLinkTarget: string;
  readonly realPathMatches: boolean;
  readonly copiedFileMatches: boolean;
  readonly copiedTreeMatches: boolean;
  readonly copyFilePreservedLink: boolean;
  readonly copyFileCopiedTarget: boolean;
  readonly writeInputRetained: boolean;
  readonly fileWriteInputRetained: boolean;
  readonly overwriteReplacedLink: boolean;
  readonly overwritePreservedTarget: boolean;
  readonly overwriteCopiedContents: boolean;
  readonly times: { readonly atimeMs: number | null; readonly mtimeMs: number | null };
  readonly stat: { readonly type: string; readonly size: bigint };
  readonly temps: {
    readonly directoryExistsInScope: boolean;
    readonly directoryRemoved: boolean;
    readonly directoryPrefix: boolean;
    readonly directoryParentIsRoot: boolean;
    readonly fileExistsInScope: boolean;
    readonly fileRemoved: boolean;
    readonly fileParentIsRoot: boolean;
    readonly fileParentPrefix: boolean;
    readonly fileBasenameExcludesPrefix: boolean;
    readonly fileSuffix: boolean;
  };
  readonly file: {
    readonly bytesRead: number;
    readonly initial: ReadonlyArray<number>;
    readonly positionAfterRead: bigint;
    readonly bytesWritten: number;
    readonly contents: ReadonlyArray<number>;
    readonly size: bigint;
  };
  readonly concurrentAppend: string;
  readonly largeAppend: {
    readonly size: bigint;
    readonly prefixMatches: boolean;
    readonly finalBytesRead: number;
    readonly finalBytes: ReadonlyArray<number>;
    readonly originalLength: number;
    readonly inputRetained: boolean;
  };
  readonly stream: { readonly size: number; readonly matches: boolean };
}

export const runFilesystemContract = (
  fs: FileSystem,
  fixture: FileSystemContractFixture,
): Effect.Effect<FileSystemContractResult, PlatformError.PlatformError, Scope.Scope> =>
  Effect.gen(function* () {
    const path = fixture.path;
    const root = fixture.root;
    const payload = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const source = path('tree', 'nested', 'payload.bin');

    yield* fs.makeDirectory(path('tree', 'nested'), { recursive: true });
    yield* fs.writeFile(source, payload);
    const writeInputRetained = sameBytes(payload, Uint8Array.from([0, 1, 2, 127, 128, 254, 255]));
    yield* fs.symlink('nested/payload.bin', path('tree', 'relative-link'));
    const directLinkTarget = yield* fs.readLink(path('tree', 'relative-link'));
    const expectedRealTarget = path('tree', 'nested', 'payload.bin');
    const realPayload = yield* fs.realPath(source);
    const realLink = yield* fs.realPath(path('tree', 'relative-link'));
    const listing = yield* fs.readDirectory(path('tree'), { recursive: true });

    yield* fs.copyFile(source, path('copy-file.bin'));
    const copiedFile = yield* fs.readFile(path('copy-file.bin'));
    yield* fs.copy(path('tree'), path('tree-copy'));
    const copiedLinkTarget = yield* fs.readLink(path('tree-copy', 'relative-link'));
    const copiedPayload = yield* fs.readFile(path('tree-copy', 'nested', 'payload.bin'));

    const copyFileTarget = path('copy-file-target.bin');
    const copyFileLink = path('copy-file-link.bin');
    yield* fs.writeFile(copyFileTarget, Uint8Array.from([9]));
    yield* fs.symlink('copy-file-target.bin', copyFileLink);
    yield* fs.copyFile(source, copyFileLink);
    const copyFileLinkTarget = yield* fs.readLink(copyFileLink);
    const copyFileTargetBytes = yield* fs.readFile(copyFileTarget);

    const replacementTarget = path('replacement-target.bin');
    const replacementLink = path('replacement-link.bin');
    yield* fs.writeFile(replacementTarget, Uint8Array.from([9]));
    yield* fs.symlink('replacement-target.bin', replacementLink);
    yield* fs.copy(source, replacementLink, { overwrite: true });
    const replacementLinkResult = yield* Effect.result(fs.readLink(replacementLink));
    const replacementTargetBytes = yield* fs.readFile(replacementTarget);
    const replacementBytes = yield* fs.readFile(replacementLink);

    const timedPath = path('times.bin');
    yield* fs.writeFile(timedPath, payload);
    yield* fs.utimes(timedPath, 1.234, new Date(5000));
    const timed = yield* fs.stat(timedPath);
    const info = yield* fs.stat(source);

    const directoryTemp = yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: 'contract-dir-' });
        return { path: temporary, exists: yield* fs.exists(temporary) };
      }),
    );
    const fileTemp = yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempFileScoped({
          directory: root,
          prefix: 'contract-file-',
          suffix: '.tmp',
        });
        yield* fs.writeFile(temporary, payload);
        return { path: temporary, exists: yield* fs.exists(temporary) };
      }),
    );
    const directoryTempParent = directoryTemp.path.replace(/[/\\][^/\\]+$/, '');
    const fileTempParent = fileTemp.path.replace(/[/\\][^/\\]+$/, '');
    const fileTempPrivateDirectoryParent = fileTempParent.replace(/[/\\][^/\\]+$/, '');
    const fileTempBasename = fileTemp.path.slice(fileTempParent.length + 1);
    const fileTempParentBasename = fileTempParent.slice(
      Math.max(fileTempParent.lastIndexOf('/'), fileTempParent.lastIndexOf('\\')) + 1,
    );

    const filePath = path('cursor.bin');
    yield* fs.writeFile(filePath, Uint8Array.from([10, 20, 30, 40, 50]));
    const file = yield* fs.open(filePath, { flag: 'r+' });
    const readBuffer = new Uint8Array(2);
    const bytesRead = yield* file.read(readBuffer);
    const positionAfterRead = yield* file.seek(0n, 'current');
    yield* file.seek(2n, 'start');
    const fileWriteInput = Uint8Array.from([99]);
    const bytesWritten = yield* file.write(fileWriteInput);
    const fileWriteInputRetained = sameBytes(fileWriteInput, Uint8Array.from([99]));
    yield* file.truncate(4);
    yield* file.sync;
    const cursorContents = yield* fs.readFile(filePath);
    const cursorInfo = yield* file.stat;
    const cursorSize = ByteSize.toBigInt(cursorInfo.size);

    const appendPath = path('concurrent-append.bin');
    yield* fs.writeFile(appendPath, new TextEncoder().encode('base'));
    const firstAppend = yield* fs.open(appendPath, { flag: 'a' });
    const secondAppend = yield* fs.open(appendPath, { flag: 'a' });
    yield* Effect.all(
      [firstAppend.writeAll(new TextEncoder().encode('A')), secondAppend.writeAll(new TextEncoder().encode('B'))],
      { concurrency: 2 },
    );
    const concurrentBytes = yield* fs.readFile(appendPath);

    const largeAppendPath = path('large-append.bin');
    const largeAppend = new Uint8Array(16 * 1024 * 1024).fill(0x5a);
    const appendedBytes = Uint8Array.from([0x70, 0x71, 0x72]);
    yield* fs.writeFile(largeAppendPath, largeAppend);
    yield* fs.writeFile(largeAppendPath, appendedBytes, { flag: 'a' });
    const largeAppendFile = yield* fs.open(largeAppendPath, { flag: 'r' });
    yield* largeAppendFile.seek(BigInt(largeAppend.byteLength), 'start');
    const finalBytes = new Uint8Array(appendedBytes.byteLength);
    const finalBytesRead = yield* largeAppendFile.read(finalBytes);
    const largeAppendInfo = yield* fs.stat(largeAppendPath);
    const largeContents = yield* fs.readFile(largeAppendPath);

    const streamBytes = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
    const streamSource = path('stream-source.bin');
    const streamDestination = path('stream-destination.bin');
    yield* fs.writeFile(streamSource, streamBytes);
    yield* Stream.run(fs.stream(streamSource, { chunkSize: 32 * 1024 }), fs.sink(streamDestination, { flag: 'w' }));
    const streamedBytes = yield* fs.readFile(streamDestination);

    return {
      directoryListing: listing,
      directLinkTarget,
      copiedLinkTarget,
      realPathMatches: realPayload === expectedRealTarget && realLink === expectedRealTarget,
      copiedFileMatches: sameBytes(copiedFile, payload),
      copiedTreeMatches: sameBytes(copiedPayload, payload),
      copyFilePreservedLink: copyFileLinkTarget === 'copy-file-target.bin',
      copyFileCopiedTarget: sameBytes(copyFileTargetBytes, payload),
      writeInputRetained,
      fileWriteInputRetained,
      overwriteReplacedLink: replacementLinkResult._tag === 'Failure',
      overwritePreservedTarget: sameBytes(replacementTargetBytes, Uint8Array.from([9])),
      overwriteCopiedContents: sameBytes(replacementBytes, payload),
      times: {
        atimeMs: Option.getOrNull(timed.atime)?.getTime() ?? null,
        mtimeMs: Option.getOrNull(timed.mtime)?.getTime() ?? null,
      },
      stat: {
        type: info.type,
        size: ByteSize.toBigInt(info.size),
      },
      temps: {
        directoryExistsInScope: directoryTemp.exists,
        directoryRemoved: !(yield* fs.exists(directoryTemp.path)),
        directoryPrefix: directoryTemp.path.includes('contract-dir-'),
        directoryParentIsRoot: directoryTempParent === root,
        fileExistsInScope: fileTemp.exists,
        fileRemoved: !(yield* fs.exists(fileTemp.path)),
        fileParentIsRoot: fileTempPrivateDirectoryParent === root,
        fileParentPrefix: fileTempParentBasename.startsWith('contract-file-'),
        fileBasenameExcludesPrefix: !fileTempBasename.startsWith('contract-file-'),
        fileSuffix: fileTempBasename.endsWith('.tmp'),
      },
      file: {
        bytesRead,
        initial: Array.from(readBuffer),
        positionAfterRead,
        bytesWritten,
        contents: Array.from(cursorContents),
        size: cursorSize,
      },
      concurrentAppend: new TextDecoder().decode(concurrentBytes),
      largeAppend: {
        size: ByteSize.toBigInt(largeAppendInfo.size),
        prefixMatches: sameBytes(largeContents.subarray(0, largeAppend.byteLength), largeAppend),
        finalBytesRead,
        finalBytes: Array.from(finalBytes),
        originalLength: largeAppend.byteLength,
        inputRetained:
          largeAppend.every((value) => value === 0x5a) && sameBytes(appendedBytes, Uint8Array.from([0x70, 0x71, 0x72])),
      },
      stream: {
        size: streamedBytes.byteLength,
        matches: sameBytes(streamedBytes, streamBytes),
      },
    };
  });

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
