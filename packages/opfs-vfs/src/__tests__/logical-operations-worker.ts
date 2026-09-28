import { OpenFlags, OpfsVfs, type OpfsVfsOptions, type SyncAccessHandleTag } from '../opfs-vfs';
import type {
  ChangeImpact,
  CompletedLogicalOperation,
  FileChangeChannel,
  LogicalChangeContribution,
  LogicalRecord,
} from '../changes';
import type { ConfiguredVfsPlugin } from '../plugins';
import { deleteVolume } from '../volume-files';

type Record = Pick<LogicalRecord, 'type' | 'path' | 'kind' | 'cursor'>;
type Result = { mode: 'memory' | 'disk'; checks: { name: string; actual: unknown; expected: unknown }[] };
const BLOCK_SIZE = 4096;

type Captured = { status: 'included'; bytes: number[] } | { status: 'omitted'; reason: string };

class CaptureRecorder {
  readonly completed: { records: LogicalRecord[]; captured: Captured[] }[] = [];
  maxBytes = 16 * 1024 * 1024;
  afterCompleted?: (operation: CompletedLogicalOperation, records: LogicalRecord[]) => void;

  plugin(): ConfiguredVfsPlugin {
    return {
      id: `capture-test-${crypto.randomUUID()}`,
      contractVersion: 1,
      compatibilityKey: 'capture-test-v1',
      logicalChanges: {
        version: 1,
        create: () => ({
          control: (_client, command) =>
            command.type === 'register'
              ? { type: 'registered', subscriptionId: command.subscriptionId }
              : { type: 'ok' },
          completed: (operation) => {
            const records = [...operation.records];
            this.completed.push({
              records,
              captured: records.map((record) => {
                const content = operation.capture(record, this.maxBytes);
                return content.status === 'included'
                  ? { status: 'included', bytes: [...content.bytes] }
                  : { status: 'omitted', reason: content.reason };
              }),
            });
            this.afterCompleted?.(operation, records);
          },
          invalidated: () => {},
          clientClosed: () => {},
          close: () => {},
        }),
      },
    };
  }

  take() {
    return this.completed.splice(0);
  }
}

type CaptureReadState = {
  armed: boolean;
  mode: 'normal' | 'short' | 'zero' | 'invalid' | 'throw';
  reads: number;
  onRead?: () => void;
};

function captureReadHook(state: CaptureReadState): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  return (handle, tag) => {
    if (tag !== 'data') return handle;
    return new Proxy(handle, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== 'read' || typeof value !== 'function')
          return typeof value === 'function' ? value.bind(target) : value;
        return (buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions) => {
          if (!state.armed) return value.call(target, buffer, options);
          state.reads++;
          const onRead = state.onRead;
          state.onRead = undefined;
          onRead?.();
          if (state.mode === 'zero') return 0;
          if (state.mode === 'invalid') return buffer.byteLength + 1;
          if (state.mode === 'throw') throw new DOMException('capture read failure', 'InvalidStateError');
          if (state.mode === 'short' && buffer.byteLength > 1) {
            const source = buffer as ArrayBufferView;
            const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength - 1);
            return value.call(target, view, options);
          }
          return value.call(target, buffer, options);
        };
      },
    });
  };
}

class Recorder {
  readonly completed: Record[][] = [];
  readonly invalidated: { impact: ChangeImpact; reason: string }[] = [];
  lastCursors: LogicalRecord['cursor'][] = [];

  constructor(
    private readonly throwCompleted = false,
    private readonly throwInvalidated = false,
  ) {}

  plugin(): ConfiguredVfsPlugin {
    const contribution: LogicalChangeContribution = {
      version: 1,
      create: () => ({
        control: (_client, command) =>
          command.type === 'register' ? { type: 'registered', subscriptionId: command.subscriptionId } : { type: 'ok' },
        completed: (operation: CompletedLogicalOperation) => {
          this.completed.push(
            [...operation.records].map(({ type, path, kind, cursor }) => ({ type, path, kind, cursor })),
          );
          if (this.throwCompleted) throw new Error('completed sentinel');
        },
        invalidated: (impact, reason) => {
          this.invalidated.push({ impact, reason });
          if (this.throwInvalidated) throw new Error('invalidated sentinel');
        },
        clientClosed: () => {},
        close: () => {},
      }),
    };
    return {
      id: `logical-test-${crypto.randomUUID()}`,
      contractVersion: 1,
      compatibilityKey: 'logical-test-v1',
      logicalChanges: contribution,
    };
  }

  take() {
    const records = this.completed.splice(0).flat();
    this.lastCursors = records.map(({ cursor }) => cursor);
    const completed = records.map(({ type, path, kind }) => `${type}:${kind}:${path}`);
    const invalidated = this.invalidated.splice(0);
    return { completed, invalidated };
  }
}

function partialDataWalHook(state: {
  armed: boolean;
  sentinel: Error;
}): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> {
  return (handle: FileSystemSyncAccessHandle, tag: SyncAccessHandleTag) => {
    if (tag !== 'dataLog') return handle;
    return new Proxy(handle, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== 'write' || typeof value !== 'function')
          return typeof value === 'function' ? value.bind(target) : value;
        return (...args: Parameters<FileSystemSyncAccessHandle['write']>) => {
          const written = value.apply(target, args);
          if (state.armed) throw state.sentinel;
          return written;
        };
      },
    });
  };
}

function same(actual: unknown, expected: unknown) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Core records only while a subscription is registered, so each recorded mount holds one. */
async function watch(vfs: OpfsVfs): Promise<void> {
  const channel = await vfs.openFileChangeChannel(
    () => {},
    () => {},
    () => {},
  );
  await channel.request({
    type: 'register',
    subscriptionId: 'watch-all',
    options: { path: '/', scope: 'directory', recursive: true, events: ['create', 'update', 'delete'], content: false },
  });
}

async function exercise(mode: 'memory' | 'disk'): Promise<Result> {
  const checks: Result['checks'] = [];
  const check = (name: string, actual: unknown, expected: unknown) => checks.push({ name, actual, expected });
  const recorder = new Recorder();
  const name = `logical-operations-${mode}-${crypto.randomUUID()}.bin`;
  const vfs = new OpfsVfs(name, { bufferMode: mode, plugins: [recorder.plugin()] });
  try {
    await vfs.ready;
    await watch(vfs);
    const bytes = (...values: number[]) => new Uint8Array(values);

    const reentrantName = `logical-reentrant-${mode}-${crypto.randomUUID()}.bin`;
    const reentrantEvents: string[] = [];
    let reentrantOperationEnded = false;
    const reentrant = new OpfsVfs(reentrantName, {
      bufferMode: mode,
      maxFiles: 2,
      plugins: [
        {
          id: `logical-reentrant-${crypto.randomUUID()}`,
          contractVersion: 1,
          compatibilityKey: 'logical-reentrant-v1',
          logicalChanges: {
            version: 1,
            create: () => ({
              control: (_client, command) => {
                if (command.type === 'register')
                  reentrantEvents.push(reentrantOperationEnded ? 'admitted-after' : 'admitted-during');
                return command.type === 'register'
                  ? { type: 'registered', subscriptionId: command.subscriptionId }
                  : { type: 'ok' };
              },
              completed: () => reentrantEvents.push('completed'),
              invalidated: () => reentrantEvents.push('invalidated'),
              clientClosed: () => {},
              close: () => {},
            }),
          },
        },
      ],
    });
    await reentrant.ready;
    const reentrantChannel: FileChangeChannel = await reentrant.openFileChangeChannel(
      () => {},
      () => {},
      () => {},
    );
    let reentrantRegistration!: Promise<unknown>;
    let reentrantError = '';
    try {
      reentrant.mkdirSync('/a/b', {
        get recursive() {
          reentrantRegistration = reentrantChannel.request({
            type: 'register',
            subscriptionId: 'reentrant',
            options: {
              path: '/',
              scope: 'directory',
              recursive: true,
              events: ['create', 'update', 'delete'],
              content: false,
            },
          });
          return true;
        },
      });
    } catch (error) {
      reentrantError = (error as { code?: string }).code ?? '';
    } finally {
      reentrantOperationEnded = true;
    }
    await reentrantRegistration;
    check(
      'reentrant registration is admitted after a partial recursive mkdir',
      [reentrantError, reentrantEvents],
      ['ENOSPC', ['admitted-after']],
    );
    await reentrant.closeVfs();
    await deleteVolume(reentrantName).catch(() => {});
    const captureName = `logical-capture-${mode}-${crypto.randomUUID()}.bin`;
    const captureRecorder = new CaptureRecorder();
    const captureVfs = new OpfsVfs(captureName, { bufferMode: mode, plugins: [captureRecorder.plugin()] });
    await captureVfs.ready;
    await watch(captureVfs);
    let staleCapture: (() => Captured) | undefined;
    let foreignCapture: Captured | undefined;
    let invalidLimitCapture: Captured | undefined;
    let heldBytes: Uint8Array | undefined;
    let frozenRecord = false;
    let reentrantCapture: Captured | undefined;
    let captureCallbacks = 0;
    captureRecorder.afterCompleted = (operation, records) => {
      captureCallbacks++;
      const record = records[0];
      if (!record) return;
      if (captureCallbacks === 1) {
        const held = operation.capture(record, 16 * 1024 * 1024);
        if (held.status === 'included') heldBytes = held.bytes;
        staleCapture = () => {
          const content = operation.capture(record, 16 * 1024 * 1024);
          return content.status === 'included'
            ? { status: 'included', bytes: [...content.bytes] }
            : { status: 'omitted', reason: content.reason };
        };
        const forged = { ...record, cursor: { ...record.cursor } };
        const content = operation.capture(forged, 16 * 1024 * 1024);
        foreignCapture =
          content.status === 'included'
            ? { status: 'included', bytes: [...content.bytes] }
            : { status: 'omitted', reason: content.reason };
        const invalid = operation.capture(record, 16 * 1024 * 1024 + 1);
        invalidLimitCapture =
          invalid.status === 'included'
            ? { status: 'included', bytes: [...invalid.bytes] }
            : { status: 'omitted', reason: invalid.reason };
        try {
          (record as { path: string }).path = '/forged';
        } catch {
          frozenRecord = true;
        }
      }
      if (captureCallbacks === 2) {
        try {
          captureVfs.writeFileBufferSync('/reentrant', new Uint8Array(16 * 1024 * 1024 + 1));
        } catch {
          // The rejected outer mutation must still expire this operation's capture token.
        }
        const content = operation.capture(record, 16 * 1024 * 1024);
        reentrantCapture =
          content.status === 'included'
            ? { status: 'included', bytes: [...content.bytes] }
            : { status: 'omitted', reason: content.reason };
      }
    };
    captureVfs.writeFileBufferSync('/file', bytes(1));
    const firstCapture = captureRecorder.take();
    const immediatelyStaleCapture = staleCapture?.();
    captureVfs.writeFileBufferSync('/file', bytes(2));
    const secondCapture = captureRecorder.take();
    const heldBeforeOverwrite = heldBytes && [...heldBytes];
    if (heldBytes) heldBytes[0] = 99;
    const heldFd = captureVfs.openSync('/file', OpenFlags.O_RDONLY);
    const liveAfterHeldMutation = [...captureVfs.readSync(heldFd, 1, 0).buffer];
    captureVfs.closeSync(heldFd);
    captureVfs.unlinkSync('/file');
    const deletedCapture = captureRecorder.take();
    captureVfs.writeFileBufferSync('/file', bytes(3));
    const recreatedCapture = captureRecorder.take();
    captureVfs.writeFileBufferSync('/empty', new Uint8Array());
    const emptyCapture = captureRecorder.take();
    captureVfs.symlinkSync('/empty', '/symlink');
    const symlinkCapture = captureRecorder.take();
    const fileFd = captureVfs.openSync('/file', OpenFlags.O_RDONLY);
    const fileAtime = captureVfs.statSync('/file').atimeMs;
    captureVfs.chmodSync('/file', 0o600);
    const fileAfterCapture = captureRecorder.take();
    check(
      'completed capture does not touch atime or caller descriptor cursors',
      [captureVfs.statSync('/file').atimeMs, captureVfs.seekSync(fileFd, 0, 1)],
      [fileAtime, 0],
    );
    captureVfs.closeSync(fileFd);
    captureVfs.mkdirSync('/directory');
    const directoryCapture = captureRecorder.take();
    captureRecorder.maxBytes = 1;
    captureVfs.writeFileBufferSync('/large', bytes(1, 2));
    const tooLargeCapture = captureRecorder.take();
    captureRecorder.maxBytes = 16 * 1024 * 1024;
    captureVfs.linkSync('/file', '/alias');
    const aliasCapture = captureRecorder.take();
    captureVfs.mkdirSync('/a-locked');
    captureVfs.mkdirSync('/z-open');
    captureVfs.writeFileBufferSync('/z-open/file', bytes(4));
    captureVfs.linkSync('/z-open/file', '/a-locked/alias');
    captureRecorder.take();
    captureVfs.chmodSync('/a-locked', 0);
    captureRecorder.take();
    captureVfs.writeFileBufferSync('/z-open/file', bytes(5));
    const deniedThenAllowed = captureRecorder.take();
    captureVfs.mkdirSync('/a-open');
    captureVfs.mkdirSync('/z-locked');
    captureVfs.writeFileBufferSync('/a-open/file', bytes(6));
    captureVfs.linkSync('/a-open/file', '/z-locked/alias');
    captureRecorder.take();
    captureVfs.chmodSync('/z-locked', 0);
    captureRecorder.take();
    captureVfs.writeFileBufferSync('/a-open/file', bytes(7));
    const allowedThenDenied = captureRecorder.take();
    captureVfs.chmodSync('/file', 0);
    const deniedCapture = captureRecorder.take();
    check(
      'completed capture freezes versions before later delete and recreation',
      [firstCapture[0]?.captured, secondCapture[0]?.captured, recreatedCapture[0]?.captured],
      [
        [{ status: 'included', bytes: [1] }],
        [{ status: 'included', bytes: [2] }],
        [{ status: 'included', bytes: [3] }],
      ],
    );
    check(
      'completed capture bytes are isolated from the current filesystem buffer',
      [heldBeforeOverwrite, liveAfterHeldMutation],
      [[1], [2]],
    );
    check(
      'completed capture reports deletion, non-files, and size limits',
      [deletedCapture[0]?.captured, directoryCapture[0]?.captured, tooLargeCapture[0]?.captured],
      [
        [{ status: 'omitted', reason: 'deleted' }],
        [{ status: 'omitted', reason: 'not-file' }],
        [{ status: 'omitted', reason: 'too-large' }],
      ],
    );
    check(
      'completed capture includes empty regular files and omits symlinks',
      [emptyCapture[0]?.captured, symlinkCapture[0]?.captured, fileAfterCapture[0]?.captured],
      [
        [{ status: 'included', bytes: [] }],
        [{ status: 'omitted', reason: 'not-file' }],
        [{ status: 'included', bytes: [3] }],
      ],
    );
    check(
      'completed capture checks each hard-link path and file permissions',
      [
        aliasCapture[0]?.captured,
        deniedThenAllowed[0]?.captured,
        allowedThenDenied[0]?.captured,
        deniedCapture[0]?.captured,
      ],
      [
        [{ status: 'included', bytes: [3] }],
        [
          { status: 'omitted', reason: 'unavailable' },
          { status: 'included', bytes: [5] },
        ],
        [
          { status: 'included', bytes: [7] },
          { status: 'omitted', reason: 'unavailable' },
        ],
        [
          { status: 'omitted', reason: 'unavailable' },
          { status: 'omitted', reason: 'unavailable' },
        ],
      ],
    );
    check(
      'completed capture rejects forged and stale records and freezes facts',
      [foreignCapture, invalidLimitCapture, frozenRecord, immediatelyStaleCapture, staleCapture?.(), reentrantCapture],
      [
        { status: 'omitted', reason: 'unavailable' },
        { status: 'omitted', reason: 'unavailable' },
        true,
        { status: 'omitted', reason: 'unavailable' },
        { status: 'omitted', reason: 'unavailable' },
        { status: 'omitted', reason: 'unavailable' },
      ],
    );

    const allocationName = `logical-capture-allocation-${mode}-${crypto.randomUUID()}.bin`;
    const allocationRecorder = new CaptureRecorder();
    const allocationVfs = new OpfsVfs(allocationName, { bufferMode: mode, plugins: [allocationRecorder.plugin()] });
    await allocationVfs.ready;
    await watch(allocationVfs);
    const originalWeakSet = globalThis.WeakSet;
    (globalThis as { WeakSet: typeof WeakSet }).WeakSet = class {
      constructor() {
        throw new Error('injected capture allocation failure');
      }
    } as never;
    try {
      allocationVfs.writeFileBufferSync('/allocation', bytes(1));
    } finally {
      (globalThis as { WeakSet: typeof WeakSet }).WeakSet = originalWeakSet;
    }
    const allocationFailure = allocationRecorder.take();
    allocationVfs.writeFileBufferSync('/allocation', bytes(2));
    check(
      'capture allocation failure omits bytes without poisoning the successful operation',
      [
        allocationVfs.statSync('/allocation').size,
        allocationFailure[0]?.captured,
        allocationRecorder.take()[0]?.captured,
      ],
      [1, [{ status: 'omitted', reason: 'unavailable' }], [{ status: 'included', bytes: [2] }]],
    );
    await allocationVfs.closeVfs();
    await deleteVolume(allocationName).catch(() => {});
    await captureVfs.closeVfs();
    await deleteVolume(captureName).catch(() => {});

    if (mode === 'disk') {
      const readState: CaptureReadState = { armed: false, mode: 'normal', reads: 0 };
      const readCaptureName = `logical-capture-read-${crypto.randomUUID()}.bin`;
      const readRecorder = new CaptureRecorder();
      const readVfs = new OpfsVfs(readCaptureName, {
        bufferMode: 'disk',
        plugins: [readRecorder.plugin()],
        _wrapSyncAccessHandle: captureReadHook(readState),
      });
      await readVfs.ready;
      await watch(readVfs);
      readVfs.writeFileBufferSync('/file', bytes(1, 2, 3));
      readVfs.linkSync('/file', '/alias');
      readRecorder.take();
      readState.armed = true;
      readState.reads = 0;
      readVfs.writeFileBufferSync('/file', bytes(4, 5, 6));
      check(
        'one operation shares an authorized hard-link capture',
        [readState.reads, readRecorder.take()[0]?.captured],
        [
          1,
          [
            { status: 'included', bytes: [4, 5, 6] },
            { status: 'included', bytes: [4, 5, 6] },
          ],
        ],
      );
      readState.mode = 'short';
      readState.reads = 0;
      readVfs.writeFileBufferSync('/file', bytes(7, 8, 9));
      check(
        'capture retries positive short physical reads exactly',
        [readState.reads, readRecorder.take()[0]?.captured],
        [
          2,
          [
            { status: 'included', bytes: [7, 8, 9] },
            { status: 'included', bytes: [7, 8, 9] },
          ],
        ],
      );
      for (const readMode of ['zero', 'invalid', 'throw'] as const) {
        readState.mode = readMode;
        readState.reads = 0;
        readVfs.writeFileBufferSync('/file', bytes(10, 11, 12));
        const captured = readRecorder.take()[0]?.captured;
        check(
          `capture ${readMode} physical read omits bytes without failing the write`,
          [readVfs.statSync('/file').size, captured],
          [
            3,
            [
              { status: 'omitted', reason: 'unavailable' },
              { status: 'omitted', reason: 'unavailable' },
            ],
          ],
        );
      }
      readState.mode = 'normal';
      readVfs.writeFileBufferSync('/sparse', bytes(1));
      readRecorder.take();
      const sparseFd = readVfs.openSync('/sparse', OpenFlags.O_WRONLY);
      readVfs.writeSync(sparseFd, bytes(2), 2 * BLOCK_SIZE);
      readVfs.closeSync(sparseFd);
      check('capture includes disk sparse holes as zeros', readRecorder.take()[0]?.captured, [
        {
          status: 'included',
          bytes: [1, ...new Array(2 * BLOCK_SIZE - 1).fill(0), 2],
        },
      ]);
      readState.onRead = () => readVfs.writeFileBufferSync('/file', bytes(1, 2, 3));
      readVfs.writeFileBufferSync('/file', bytes(13, 14, 15));
      const reentered = readRecorder.take();
      check('capture rechecks its token after a reentrant physical read', reentered.at(-1)?.captured, [
        { status: 'omitted', reason: 'unavailable' },
        { status: 'omitted', reason: 'unavailable' },
      ]);
      await readVfs.closeVfs();
      await deleteVolume(readCaptureName).catch(() => {});

      const metadataState: CaptureReadState = { armed: false, mode: 'normal', reads: 0 };
      const metadataName = `logical-metadata-capture-${crypto.randomUUID()}.bin`;
      const metadataRecorder = new Recorder();
      const metadataVfs = new OpfsVfs(metadataName, {
        bufferMode: 'disk',
        plugins: [metadataRecorder.plugin()],
        _wrapSyncAccessHandle: captureReadHook(metadataState),
      });
      await metadataVfs.ready;
      await watch(metadataVfs);
      metadataVfs.writeFileBufferSync('/metadata', bytes(1));
      metadataRecorder.take();
      metadataState.armed = true;
      metadataState.reads = 0;
      metadataVfs.chmodSync('/metadata', 0o600);
      check('metadata-only completion makes no physical content read', metadataState.reads, 0);
      await metadataVfs.closeVfs();
      await deleteVolume(metadataName).catch(() => {});

      const persistenceNames = [
        `logical-capture-persistence-${crypto.randomUUID()}.bin`,
        `logical-plain-persistence-${crypto.randomUUID()}.bin`,
      ];
      const capturePersistence = new OpfsVfs(persistenceNames[0], {
        bufferMode: 'disk',
        plugins: [new CaptureRecorder().plugin()],
      });
      const plainPersistence = new OpfsVfs(persistenceNames[1], {
        bufferMode: 'disk',
        plugins: [new Recorder().plugin()],
      });
      await Promise.all([capturePersistence.ready, plainPersistence.ready]);
      for (const fs of [capturePersistence, plainPersistence]) {
        fs.writeFileBufferSync('/persistence', bytes(1));
        fs.flushVfs();
        fs.chmodSync('/persistence', 0o600);
      }
      const persistence = (fs: OpfsVfs) => {
        const { dirtyPages, walPendingBytes, localPersistenceState } = fs.getLocalPersistenceStatusSync();
        return { dirtyPages, walPendingBytes, localPersistenceState };
      };
      check(
        'capture leaves mutation persistence state unchanged',
        persistence(capturePersistence),
        persistence(plainPersistence),
      );
      await Promise.all([capturePersistence.closeVfs(), plainPersistence.closeVfs()]);
      await Promise.all(persistenceNames.map((volume) => deleteVolume(volume).catch(() => {})));
    }

    const inactiveName = `logical-inactive-${mode}-${crypto.randomUUID()}.bin`;
    const inactive = new OpfsVfs(inactiveName, { bufferMode: mode });
    await inactive.ready;
    let unavailable = '';
    try {
      await inactive.openFileChangeChannel(
        () => {},
        () => {},
        () => {},
      );
    } catch (e) {
      unavailable = (e as { code?: string }).code ?? '';
    }
    check('inactive mount rejects the direct change channel', unavailable, 'ENOTSUP');
    (inactive as unknown as { withLogicalOperation: () => never }).withLogicalOperation = () => {
      throw new Error('writeFileBufferSync entered logical operation without a plugin');
    };
    inactive.writeFileBufferSync('/fast-path', bytes(1));
    check('whole-file write bypasses logical operation without a plugin', inactive.statSync('/fast-path').size, 1);
    await inactive.closeVfs();
    await deleteVolume(inactiveName).catch(() => {});

    const sequenceName = `logical-sequence-${mode}-${crypto.randomUUID()}.bin`;
    const sequenceRecorder = new Recorder();
    const sequenceVfs = new OpfsVfs(sequenceName, { bufferMode: mode, plugins: [sequenceRecorder.plugin()] });
    await sequenceVfs.ready;
    await watch(sequenceVfs);
    let sequenceInterrupted = '';
    const sequenceChannel = await sequenceVfs.openFileChangeChannel(
      () => {},
      (code) => {
        sequenceInterrupted = code;
      },
      () => {},
    );
    (sequenceVfs as unknown as { logicalSequence: number }).logicalSequence = Number.MAX_SAFE_INTEGER;
    sequenceVfs.writeFileBufferSync('/sequence', bytes(1));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    check(
      'sequence exhaustion preserves the mutation and interrupts the channel',
      [sequenceVfs.statSync('/sequence').size, sequenceRecorder.take().completed, sequenceInterrupted],
      [1, [], 'SUBSCRIPTION_INTERRUPTED'],
    );
    sequenceChannel.close();
    await sequenceVfs.closeVfs();
    await deleteVolume(sequenceName).catch(() => {});

    if (mode === 'memory') {
      const faultName = `logical-partial-${crypto.randomUUID()}.bin`;
      const faultRecorder = new Recorder(false, true);
      const sentinel = new Error('logical data WAL sentinel');
      const faultState = { armed: false, sentinel };
      const fault = new OpfsVfs(faultName, {
        bufferMode: 'memory',
        plugins: [faultRecorder.plugin()],
        _wrapSyncAccessHandle: partialDataWalHook(faultState),
      });
      await fault.ready;
      await watch(fault);
      fault.writeFileBufferSync('/fault', bytes(1));
      fault.linkSync('/fault', '/fault-alias');
      faultRecorder.take();
      let invalidationInterrupted = '';
      const faultChannel = await fault.openFileChangeChannel(
        () => {},
        (code) => {
          invalidationInterrupted = code;
        },
        () => {},
      );
      faultState.armed = true;
      let thrown: unknown;
      try {
        fault.writeFileBufferSync('/fault', bytes(2));
      } catch (error) {
        thrown = error;
      }
      const partial = faultRecorder.take();
      check('partial data-WAL failure preserves its original error', thrown === sentinel, true);
      check('partial data-WAL failure discards records and invalidates every live alias', partial, {
        completed: [],
        invalidated: [
          {
            impact: {
              kind: 'paths',
              paths: [
                { path: '/fault', subtree: false },
                { path: '/fault-alias', subtree: false },
              ],
            },
            reason: 'partial-mutation',
          },
        ],
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      check(
        'a throwing invalidated contribution cannot replace the original failure',
        invalidationInterrupted,
        'SUBSCRIPTION_RESYNC_REQUIRED',
      );
      faultChannel.close();
      faultState.armed = false;
      await fault.closeVfs()?.catch(() => {});
      await deleteVolume(faultName).catch(() => {});
    }

    const throwName = `logical-completed-throw-${mode}-${crypto.randomUUID()}.bin`;
    const throwing = new OpfsVfs(throwName, { bufferMode: mode, plugins: [new Recorder(true).plugin()] });
    await throwing.ready;
    await watch(throwing);
    let completionThrow = '';
    try {
      throwing.writeFileBufferSync('/survives', bytes(1));
    } catch (error) {
      completionThrow = String(error);
    }
    check(
      'a throwing completed contribution preserves the successful filesystem result',
      [completionThrow, throwing.statSync('/survives').size],
      ['', 1],
    );
    let interrupted = '';
    try {
      await throwing.openFileChangeChannel(
        () => {},
        (code) => {
          interrupted = code;
        },
        () => {},
      );
    } catch (error) {
      interrupted = (error as { code?: string }).code ?? interrupted;
    }
    check('a throwing completed contribution is contained by resync interruption', interrupted, 'ENOTSUP');
    await throwing.closeVfs();
    await deleteVolume(throwName).catch(() => {});

    vfs.writeFileBufferSync('/new', bytes(1, 2));
    check('whole-file create is one create', recorder.take().completed, ['create:file:/new']);
    const generation = recorder.lastCursors[0]?.generation;
    vfs.writeFileBufferSync('/new', bytes(3));
    check('whole-file replacement is one update', recorder.take().completed, ['update:file:/new']);
    check(
      'record cursors are monotonic in one mount generation',
      [recorder.lastCursors[0]?.sequence, recorder.lastCursors[0]?.generation === generation],
      [2, true],
    );
    vfs.writeFileBufferSync('/new', bytes(4), { append: true });
    const fd = vfs.openSync('/new', OpenFlags.O_RDONLY);
    const appended = vfs.readSync(fd, 2, 0).buffer;
    vfs.closeSync(fd);
    check('append reports final update', recorder.take().completed, ['update:file:/new']);
    check('append has final bytes', [...appended], [3, 4]);

    const open = vfs.openSync('/low', OpenFlags.O_CREAT | OpenFlags.O_WRONLY);
    check('open create is separate', recorder.take().completed, ['create:file:/low']);
    vfs.writeSync(open, bytes(9));
    vfs.closeSync(open);
    check('low-level write is separate update', recorder.take().completed, ['update:file:/low']);

    const zeroFd = vfs.openSync('/low', OpenFlags.O_WRONLY);
    vfs.writeSync(zeroFd, new Uint8Array(0));
    vfs.closeSync(zeroFd);
    check('zero write is silent', recorder.take().completed, []);
    const sameSizeFd = vfs.openSync('/same-size', OpenFlags.O_CREAT | OpenFlags.O_WRONLY);
    vfs.closeSync(sameSizeFd);
    recorder.take();
    const originalNow = Date.now;
    try {
      Date.now = () => 1_700_000_000_001;
      const truncateSameSizeFd = vfs.openSync('/same-size', OpenFlags.O_WRONLY);
      vfs.ftruncateSync(truncateSameSizeFd, 0);
      vfs.closeSync(truncateSameSizeFd);
      check(
        'same-size truncate updates mtime without a logical record',
        [vfs.statSync('/same-size').mtimeMs, recorder.take().completed],
        [1_700_000_000_001, []],
      );
      Date.now = () => 1_700_000_000_002;
      const truncatingFd = vfs.openSync('/same-size', OpenFlags.O_WRONLY | OpenFlags.O_TRUNC);
      vfs.closeSync(truncatingFd);
      check(
        'O_TRUNC on an empty file updates mtime without a logical record',
        [vfs.statSync('/same-size').mtimeMs, recorder.take().completed],
        [1_700_000_000_002, []],
      );
    } finally {
      Date.now = originalNow;
    }
    const truncateFd = vfs.openSync('/low', OpenFlags.O_WRONLY);
    vfs.ftruncateSync(truncateFd, vfs.statSync('/low').size);
    vfs.closeSync(truncateFd);
    // Read after the truncate: a same-size truncate still bumps mtime.
    const stat = vfs.statSync('/low');
    vfs.chmodSync('/low', stat.mode);
    vfs.utimesSync('/low', stat.atimeMs ?? 0, stat.mtimeMs ?? 0);
    vfs.mkdirSync('/made/deep', { recursive: true });
    check('recursive mkdir groups parent-first creates', recorder.take().completed, [
      'create:directory:/made',
      'create:directory:/made/deep',
    ]);
    vfs.mkdirSync('/made/deep', { recursive: true });
    check('recursive mkdir existing target is silent', recorder.take().completed, []);
    vfs.chmodSync('/low', 0o600);
    check('changed chmod updates the inode', recorder.take().completed, ['update:file:/low']);
    vfs.utimesSync('/low', 101, 102);
    check('changed explicit timestamps update the inode', recorder.take().completed, ['update:file:/low']);

    vfs.symlinkSync('/new', '/new-link');
    check('symlink creation records the link path', recorder.take().completed, ['create:symlink:/new-link']);
    vfs.writeFileBufferSync('/new-link', bytes(6));
    check('writes through symlinks update only the resolved target', recorder.take().completed, ['update:file:/new']);

    vfs.linkSync('/new', '/alias');
    check('hardlink only creates new name', recorder.take().completed, ['create:file:/alias']);
    const aliasFd = vfs.openSync('/alias', OpenFlags.O_WRONLY);
    vfs.writeSync(aliasFd, bytes(7), 0);
    check('inode update fans out sorted live names', recorder.take().completed, [
      'update:file:/alias',
      'update:file:/new',
    ]);
    vfs.unlinkSync('/alias');
    check('unlink only deletes removed name', recorder.take().completed, ['delete:file:/alias']);
    vfs.linkSync('/new', '/alias');
    recorder.take();
    vfs.unlinkSync('/alias');
    vfs.writeSync(aliasFd, bytes(8), 0);
    vfs.closeSync(aliasFd);
    check('stale unlinked fd reports surviving path only', recorder.take().completed, [
      'delete:file:/alias',
      'update:file:/new',
    ]);
    const loneFd = vfs.openSync('/low', OpenFlags.O_WRONLY);
    vfs.unlinkSync('/low');
    vfs.writeSync(loneFd, bytes(2), 0);
    vfs.closeSync(loneFd);
    check('writing an unlinked last alias is silent', recorder.take().completed, ['delete:file:/low']);

    vfs.mkdirSync('/tree');
    vfs.writeFileBufferSync('/tree/a', bytes(1));
    vfs.mkdirSync('/tree/sub');
    vfs.writeFileBufferSync('/tree/sub/b', bytes(2));
    recorder.take();
    vfs.removeSync('/tree');
    check('recursive removal is child-before-parent', recorder.take().completed, [
      'delete:file:/tree/sub/b',
      'delete:file:/tree/a',
      'delete:directory:/tree/sub',
      'delete:directory:/tree',
    ]);

    vfs.mkdirSync('/move');
    vfs.writeFileBufferSync('/move/child', bytes(1));
    recorder.take();
    vfs.renameSync('/move', '/moved');
    check('subtree rename deletes old paths then creates new paths', recorder.take().completed, [
      'delete:file:/move/child',
      'delete:directory:/move',
      'create:directory:/moved',
      'create:file:/moved/child',
    ]);

    vfs.writeFileBufferSync('/from', bytes(1));
    vfs.writeFileBufferSync('/to', bytes(2));
    recorder.take();
    vfs.renameSync('/from', '/to');
    check('rename replacement deletes destination then source then creates destination', recorder.take().completed, [
      'delete:file:/to',
      'delete:file:/from',
      'create:file:/to',
    ]);
    vfs.linkSync('/to', '/same');
    recorder.take();
    vfs.renameSync('/to', '/same');
    check('same-inode rename is silent', recorder.take().completed, []);

    vfs.mkdirSync('/nonempty');
    vfs.writeFileBufferSync('/nonempty/child', bytes(1));
    recorder.take();
    let rejectedRename = '';
    try {
      vfs.renameSync('/to', '/nonempty');
    } catch (e) {
      rejectedRename = (e as { code?: string }).code ?? '';
    }
    const rejected = recorder.take();
    check(
      'file-to-directory rename rejects before recording',
      [rejectedRename, rejected],
      ['EISDIR', { completed: [], invalidated: [] }],
    );
    vfs.mkdirSync('/source-dir');
    recorder.take();
    try {
      vfs.renameSync('/source-dir', '/nonempty');
    } catch (e) {
      rejectedRename = (e as { code?: string }).code ?? '';
    }
    check(
      'nonempty directory replacement rejects before recording',
      [rejectedRename, recorder.take()],
      ['ENOTEMPTY', { completed: [], invalidated: [] }],
    );

    vfs.mkdirSync('/bulk');
    recorder.take();
    for (let index = 0; index <= 4096; index++) {
      vfs.writeFileBufferSync(`/bulk/${index}`, bytes(index & 255));
      recorder.take();
    }
    vfs.removeSync('/bulk');
    const overflow = recorder.take();
    check('oversized scope discards completed records', overflow.completed, []);
    check('oversized subtree keeps a precise invalidation region', overflow.invalidated, [
      { impact: { kind: 'paths', paths: [{ path: '/bulk', subtree: true }] }, reason: 'record-limit' },
    ]);

    const quotaName = `logical-quota-${mode}-${crypto.randomUUID()}.bin`;
    const quotaRecorder = new Recorder();
    const tooSmall = new OpfsVfs(quotaName, {
      bufferMode: mode,
      maxFileSize: 1,
      plugins: [quotaRecorder.plugin()],
    });
    await tooSmall.ready;
    await watch(tooSmall);
    let error = '';
    try {
      tooSmall.writeFileBufferSync('/missing', bytes(1, 2));
    } catch (e) {
      error = (e as { code?: string }).code ?? '';
    }
    check('preflight rejects oversized missing file', error, 'EFBIG');
    let missing = '';
    try {
      tooSmall.lstatSync('/missing');
    } catch (e) {
      missing = (e as { code?: string }).code ?? '';
    }
    check('preflight leaves missing entry absent', missing, 'ENOENT');
    check('preflight failure emits no record or invalidation', quotaRecorder.take(), {
      completed: [],
      invalidated: [],
    });
    await tooSmall.closeVfs();
    await deleteVolume(quotaName).catch(() => {});

    const totalName = `logical-total-${mode}-${crypto.randomUUID()}.bin`;
    const totalRecorder = new Recorder();
    const totalLimit = mode === 'disk' ? 4096 : 1;
    const total = new OpfsVfs(totalName, {
      bufferMode: mode,
      maxTotalBytes: totalLimit,
      plugins: [totalRecorder.plugin()],
    });
    await total.ready;
    await watch(total);
    total.writeFileBufferSync('/exists', bytes(1));
    totalRecorder.take();
    error = '';
    try {
      total.writeFileBufferSync('/missing', new Uint8Array(totalLimit + 1));
    } catch (e) {
      error = (e as { code?: string }).code ?? '';
    }
    check('total-byte preflight rejects before missing create', error, 'ENOSPC');
    try {
      total.writeFileBufferSync('/exists', new Uint8Array(totalLimit), { append: true });
    } catch (e) {
      error = (e as { code?: string }).code ?? '';
    }
    const totalFd = total.openSync('/exists', OpenFlags.O_RDONLY);
    const unchanged = total.readSync(totalFd, 1, 0).buffer;
    total.closeSync(totalFd);
    check('append preflight leaves existing bytes unchanged', [...unchanged], [1]);
    check('quota failures emit no record or invalidation', totalRecorder.take(), { completed: [], invalidated: [] });
    await total.closeVfs();
    await deleteVolume(totalName).catch(() => {});

    if (mode === 'disk') {
      const sparseName = `logical-empty-append-${crypto.randomUUID()}.bin`;
      const sparseRecorder = new Recorder();
      const sparse = new OpfsVfs(sparseName, {
        bufferMode: 'disk',
        maxTotalBytes: 0,
        plugins: [sparseRecorder.plugin()],
      });
      await sparse.ready;
      await watch(sparse);
      const sparseFd = sparse.openSync('/f', OpenFlags.O_CREAT | OpenFlags.O_WRONLY);
      sparse.ftruncateSync(sparseFd, 1);
      sparse.closeSync(sparseFd);
      sparseRecorder.take();
      sparse.writeFileBufferSync('/f', new Uint8Array(), { append: true });
      check('empty append keeps sparse file size at a zero-byte total quota', sparse.statSync('/f').size, 1);
      check('empty append emits no record or invalidation', sparseRecorder.take(), { completed: [], invalidated: [] });
      await sparse.closeVfs();
      await deleteVolume(sparseName).catch(() => {});

      const longName = `/${'界'.repeat(1_500_000)}`;
      const longPathName = `logical-utf8-fanout-${crypto.randomUUID()}.bin`;
      const longPathRecorder = new Recorder();
      const longPath = new OpfsVfs(longPathName, {
        bufferMode: 'disk',
        maxNameLength: 5 * 1024 * 1024,
        plugins: [longPathRecorder.plugin()],
      });
      await longPath.ready;
      await watch(longPath);
      const longFd = longPath.openSync(longName, OpenFlags.O_CREAT | OpenFlags.O_WRONLY);
      longPathRecorder.take();
      const encodeDescriptor = Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encode');
      if (!encodeDescriptor || typeof encodeDescriptor.value !== 'function')
        throw new Error('TextEncoder.encode unavailable');
      const originalEncode = encodeDescriptor.value as TextEncoder['encode'];
      let encodedPath = false;
      TextEncoder.prototype.encode = function (input?: string) {
        if (input === longName) encodedPath = true;
        return originalEncode.call(this, input);
      };
      let longWrite = 0;
      try {
        longWrite = longPath.writeSync(longFd, bytes(1));
      } finally {
        Object.defineProperty(TextEncoder.prototype, 'encode', encodeDescriptor);
      }
      longPath.closeSync(longFd);
      const longResult = longPathRecorder.take();
      check(
        'CJK final fanout rejects before UTF-8 allocation',
        [longWrite, encodedPath, longResult.completed, longResult.invalidated.map(({ reason }) => reason)],
        [1, false, [], ['record-limit']],
      );
      await longPath.closeVfs();
      await deleteVolume(longPathName).catch(() => {});
    }

    const appendName = `logical-append-${mode}-${crypto.randomUUID()}.bin`;
    const appendRecorder = new Recorder();
    const append = new OpfsVfs(appendName, { bufferMode: mode, plugins: [appendRecorder.plugin()] });
    await append.ready;
    await watch(append);
    append.writeFileBufferSync('/existing', bytes(1));
    appendRecorder.take();
    error = '';
    try {
      append.writeFileBufferSync('/existing', new Uint8Array(16 * 1024 * 1024), { append: true });
    } catch (e) {
      error = (e as { code?: string }).code ?? '';
    }
    const appendFd = append.openSync('/existing', OpenFlags.O_RDONLY);
    const appendUnchanged = append.readSync(appendFd, 1, 0).buffer;
    append.closeSync(appendFd);
    check('16 MiB append rejects before touching existing bytes', [error, [...appendUnchanged]], ['EFBIG', [1]]);
    check('16 MiB append failure emits no record or invalidation', appendRecorder.take(), {
      completed: [],
      invalidated: [],
    });
    await append.closeVfs();
    await deleteVolume(appendName).catch(() => {});

    return { mode, checks };
  } finally {
    await vfs.closeVfs()?.catch(() => {});
    await deleteVolume(name).catch(() => {});
  }
}

self.onmessage = async ({ data }: MessageEvent<{ mode: 'memory' | 'disk' }>) => {
  try {
    const result = await exercise(data.mode);
    const failed = result.checks.find(({ actual, expected }) => !same(actual, expected));
    if (failed)
      throw new Error(
        `${result.mode} ${failed.name}: ${JSON.stringify(failed.actual)} !== ${JSON.stringify(failed.expected)}`,
      );
    postMessage({ type: 'RESULT', result });
  } catch (error) {
    postMessage({ type: 'ERROR', error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
};
