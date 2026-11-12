import { ByteSize, Effect, Option, PlatformError, Scope, Stream } from 'effect';
import type { FileSystem } from 'effect/FileSystem';

export interface FileSystemContractFixture {
  readonly root: string;
  readonly path: (...parts: ReadonlyArray<string>) => string;
}

export interface FileSystemContractResult {
  readonly directoryListing: ReadonlyArray<string>;
  readonly globListing: ReadonlyArray<string>;
  readonly linkType: string;
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
  readonly remove: {
    readonly fileRemoved: boolean;
    readonly linkRemoved: boolean;
    readonly linkTargetKept: boolean;
    readonly treeRemoved: boolean;
    readonly missing: string;
    readonly forcedMissing: string;
    readonly forcedRecursiveMissing: string;
    readonly directories: Readonly<Record<'empty' | 'full' | 'forcedEmpty', Readonly<Record<string, unknown>>>>;
  };
  readonly dots: {
    readonly copiedThroughParent: boolean;
    readonly existingUntouched: boolean;
    readonly selfCopyRejected: boolean;
    readonly selfCopyCreated: boolean;
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
    const globListing = yield* fs.glob('**/*', { root: path('tree') });
    const linkType = (yield* fs.lstat(path('tree', 'relative-link'))).type;

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

    const removeFile = path('remove', 'file.bin');
    const removeTarget = path('remove', 'target.bin');
    const removeLink = path('remove', 'link');
    const removeTree = path('remove', 'tree');
    const removeMissing = path('remove', 'missing');
    yield* fs.makeDirectory(path('remove', 'tree', 'nested'), { recursive: true });
    yield* fs.writeFile(removeFile, payload);
    yield* fs.writeFile(removeTarget, payload);
    yield* fs.writeFile(path('remove', 'tree', 'nested', 'leaf.bin'), payload);
    yield* fs.symlink('target.bin', removeLink);
    yield* fs.remove(removeFile);
    yield* fs.remove(removeLink);
    yield* fs.remove(removeTree, { recursive: true });
    const missingRemoval = yield* Effect.result(fs.remove(removeMissing));
    const forcedMissing = yield* Effect.result(fs.remove(removeMissing, { force: true }));
    const forcedRecursiveMissing = yield* Effect.result(fs.remove(removeMissing, { recursive: true, force: true }));
    // Dot segments after an existing directory: Node and the volume reach the same place here. They
    // differ after a missing component or a symlink, which this suite therefore does not cover.
    yield* fs.makeDirectory(path('dots', 'existing'), { recursive: true });
    yield* fs.makeDirectory(path('dots', 'out'));
    yield* fs.makeDirectory(path('dots', 'source'));
    yield* fs.writeFile(path('dots', 'source', 'file.bin'), payload);
    const dottedExisting = `${path('dots', 'existing')}/..`;
    yield* fs.copy(path('dots', 'source', 'file.bin'), `${dottedExisting}/out/file.bin`);
    const dottedSelf = yield* Effect.result(fs.copy(path('dots', 'source'), `${dottedExisting}/source/inner`));
    const dots = {
      copiedThroughParent: sameBytes(yield* fs.readFile(path('dots', 'out', 'file.bin')), payload),
      existingUntouched: (yield* fs.readDirectory(path('dots', 'existing'))).length === 0,
      selfCopyRejected: dottedSelf._tag === 'Failure',
      selfCopyCreated: yield* fs.exists(path('dots', 'source', 'inner')),
    };
    const removeEmptyDirectory = path('remove', 'empty-directory');
    const removeFullDirectory = path('remove', 'full-directory');
    yield* fs.makeDirectory(removeEmptyDirectory);
    yield* fs.makeDirectory(removeFullDirectory);
    yield* fs.writeFile(path('remove', 'full-directory', 'leaf.bin'), payload);
    // Node reports the rejection as Unknown with an ERR_FS_EISDIR cause (errno 21); adapters expose it via details.
    const directoryRemoval = (directory: string, options?: { readonly force?: boolean }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(fs.remove(directory, options));
        const exists = yield* fs.exists(directory);
        if (result._tag === 'Success') return { result: 'Success', exists };
        const reason = result.failure.reason;
        const cause = (reason.cause ?? {}) as {
          readonly code?: unknown;
          readonly errno?: unknown;
          readonly details?: { readonly errno?: unknown } | null;
        };
        return {
          result: reason._tag,
          syscall: 'syscall' in reason ? reason.syscall : undefined,
          code: cause.code,
          errno: cause.errno ?? cause.details?.errno,
          exists,
        };
      });
    const removeDirectories = {
      empty: yield* directoryRemoval(removeEmptyDirectory),
      full: yield* directoryRemoval(removeFullDirectory),
      forcedEmpty: yield* directoryRemoval(removeEmptyDirectory, { force: true }),
    };
    const remove = {
      directories: removeDirectories,
      fileRemoved: !(yield* fs.exists(removeFile)),
      linkRemoved: (yield* Effect.result(fs.readLink(removeLink)))._tag === 'Failure',
      linkTargetKept: sameBytes(yield* fs.readFile(removeTarget), payload),
      treeRemoved: !(yield* fs.exists(removeTree)),
      missing: missingRemoval._tag === 'Failure' ? missingRemoval.failure.reason._tag : 'Success',
      forcedMissing: forcedMissing._tag,
      forcedRecursiveMissing: forcedRecursiveMissing._tag,
    };

    const streamBytes = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
    const streamSource = path('stream-source.bin');
    const streamDestination = path('stream-destination.bin');
    yield* fs.writeFile(streamSource, streamBytes);
    yield* Stream.run(fs.stream(streamSource, { chunkSize: 32 * 1024 }), fs.sink(streamDestination, { flag: 'w' }));
    const streamedBytes = yield* fs.readFile(streamDestination);

    return {
      directoryListing: listing,
      globListing,
      linkType,
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
      remove,
      dots,
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
