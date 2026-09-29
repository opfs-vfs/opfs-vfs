import {
  ByteSize,
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from 'effect';
import { OpenFlags, type OpfsVfs, type VfsStat } from '@opfs-vfs/opfs-vfs';
import { VfsCommandError } from '@opfs-vfs/opfs-vfs/worker';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import { getCoordinator, type Coordinator } from './coordinator.js';
import { makeSubscriptionInternal } from './subscriptions-internal.js';
import type { SubscriptionAdmission } from './subscriptions-internal.js';
import { Volume } from './volume.js';
import type { VolumeService } from './volume.js';
import { EncryptionError, SubscriptionError, VolumeError, mountError, remoteDetails } from './errors.js';

const moduleName = 'FileSystem';
const maxWholeFileBytes = 16 * 1024 * 1024;
type Backend = OpfsVfs | OpfsVfsWorkerClient;
type Stat = VfsStat;

const commandOutcome = (error: unknown, mutate: boolean) =>
  error instanceof VfsCommandError && error.dispatch === 'refused'
    ? 'not-applied'
    : error instanceof VfsCommandError && error.dispatch === 'sent' && mutate
      ? 'possibly-applied'
      : 'unknown';

const commandMountError = (error: unknown, fileName: string | null, method: string) =>
  mountError(
    error instanceof VfsCommandError ? error.cause : error,
    fileName,
    method,
    undefined,
    commandOutcome(error, false),
  );

const terminalCommandError = (
  terminal: VolumeError,
  fileName: string,
  operation: string,
  outcome: ReturnType<typeof commandOutcome>,
) =>
  new VolumeError({
    kind: 'lifecycle',
    fileName,
    operation,
    ...(terminal.code === undefined ? {} : { code: terminal.code }),
    outcome,
    details: terminal.details,
    ...(terminal.cause === undefined ? {} : { cause: terminal.cause }),
  });

const sysTag = (
  details: ReturnType<typeof remoteDetails>,
  decoded: VolumeError | ReturnType<typeof mountError>,
):
  | 'AlreadyExists'
  | 'BadResource'
  | 'Busy'
  | 'InvalidData'
  | 'NotFound'
  | 'PermissionDenied'
  | 'TimedOut'
  | 'Unknown' => {
  if (decoded instanceof VolumeError && decoded.kind === 'lifecycle' && decoded.cause !== undefined) return 'Unknown';
  const code = details.code ?? '';
  if (code === 'ENOENT') return 'NotFound';
  if (code === 'EEXIST') return 'AlreadyExists';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionDenied';
  if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EBADF') return 'BadResource';
  if (code === 'EBUSY') return 'Busy';
  if (code === 'VFS_OWNER_READY_TIMEOUT' || code === 'LEADER_RESPONSE_TIMEOUT') return 'TimedOut';
  if (decoded instanceof VolumeError && decoded.kind === 'corruption') return 'InvalidData';
  if (
    'reason' in decoded &&
    (decoded.reason === 'IntegrityFailure' || decoded.reason === 'VaultCorrupt' || decoded.reason === 'SidecarCorrupt')
  )
    return 'InvalidData';
  return 'Unknown';
};

const platform = (
  error: unknown,
  method: string,
  path?: string,
  fileName: string | null = null,
  mutate = false,
): PlatformError.PlatformError => {
  if (PlatformError.isPlatformError(error)) return error;
  const command = error instanceof VfsCommandError ? error : undefined;
  const source = command?.cause ?? error;
  const details = remoteDetails(source);
  const outcome = commandOutcome(error, mutate);
  const decoded = error instanceof VolumeError ? error : mountError(source, fileName, method, undefined, outcome);
  return PlatformError.systemError({
    _tag: sysTag(details, decoded),
    module: moduleName,
    method,
    ...(path === undefined ? {} : { pathOrDescriptor: path }),
    ...(details.message ? { description: details.message } : {}),
    cause: decoded,
  });
};

const invalidPath = (method: string, path: string) =>
  typeof path !== 'string' || !path.startsWith('/')
    ? PlatformError.badArgument({ module: moduleName, method, description: 'path must be absolute' })
    : undefined;

const unsupported = (method: string, path?: string, fileName: string | null = null) =>
  PlatformError.systemError({
    _tag: 'Unknown',
    module: moduleName,
    method,
    ...(path === undefined ? {} : { pathOrDescriptor: path }),
    description: 'Operation is not supported by this adapter slice',
    cause: new VolumeError({
      kind: 'unsupported',
      fileName,
      operation: method,
      ...(path === undefined ? {} : { path }),
      code: 'ENOTSUP',
      outcome: 'not-applied',
      details: null,
    }),
  });

const watchInterrupted = (state: Coordinator, path: string, cause: unknown) => {
  const subscriptionError = new SubscriptionError({
    code: 'SUBSCRIPTION_INTERRUPTED',
    fileName: state.fileName,
    path,
    sourceCode: 'VFS_ATTACHMENT_LOST',
    details: remoteDetails(cause),
  });
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: moduleName,
    method: 'watch',
    pathOrDescriptor: path,
    cause: subscriptionError,
  });
};

const watchFailure = (state: Coordinator, path: string, error: unknown): PlatformError.PlatformError => {
  if (PlatformError.isPlatformError(error)) {
    const cause = error.reason.cause;
    return Schema.is(VolumeError)(cause) && cause.code === 'VFS_ATTACHMENT_LOST'
      ? watchInterrupted(state, path, cause)
      : error;
  }
  if (!Schema.is(SubscriptionError)(error)) return platform(error, 'watch', path, state.fileName);
  if (Schema.is(VolumeError)(error.cause) && error.cause.kind === 'unsupported')
    return platform(error.cause, 'watch', path, state.fileName);
  if (error.code === 'SUBSCRIPTION_INTERRUPTED')
    return PlatformError.systemError({
      _tag: 'Unknown',
      module: moduleName,
      method: 'watch',
      pathOrDescriptor: path,
      cause: error,
    });
  if (error.sourceCode === 'VFS_ATTACHMENT_LOST')
    return watchInterrupted(state, path, error);
  if (
    error.sourceCode === 'VFS_OWNER_READY_TIMEOUT' ||
    error.sourceCode === 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT'
  )
    return PlatformError.systemError({
      _tag: 'TimedOut',
      module: moduleName,
      method: 'watch',
      pathOrDescriptor: path,
      cause: error,
    });
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: moduleName,
    method: 'watch',
    pathOrDescriptor: path,
    cause: error,
  });
};

const execute = <A>(
  state: Coordinator,
  method: string,
  path: string,
  run: (backend: Backend, generation: string) => A | Promise<A> | Effect.Effect<A, unknown>,
  mutate = false,
  recapture = true,
  expectedGeneration?: string,
  readinessBudget?: { remaining: number },
  interruptibleGate = true,
): Effect.Effect<A, PlatformError.PlatformError> => {
  const pathFailure = invalidPath(method, path);
  if (pathFailure) return Effect.fail(pathFailure);
  return Effect.gen(function* () {
    const budget = readinessBudget ?? { remaining: state.readinessTimeout };
    let recaptures = 0;
    let refusal: VfsCommandError | undefined;
    let differentGeneration: string | undefined;
    while (true) {
      const admitted = yield* Effect.result(state.awaitReady(budget, method));
      if (admitted._tag === 'Failure')
        return yield* Effect.fail(
          platform(
            refusal && remoteDetails(admitted.failure).code === 'VFS_OWNER_READY_TIMEOUT'
              ? refusal
              : state.terminal()
                ? terminalCommandError(admitted.failure, state.fileName, method, 'not-applied')
                : admitted.failure,
            method,
            path,
            state.fileName,
            mutate,
          ),
        );
      const generation = admitted.success;
      if (expectedGeneration !== undefined && generation !== expectedGeneration)
        return yield* Effect.fail(platform(ownerChanged(), method, path, state.fileName, mutate));
      if (differentGeneration === generation)
        return yield* Effect.fail(platform(refusal!, method, path, state.fileName, mutate));
      const makeAttempt = () =>
        Effect.scoped(
          Effect.gen(function* () {
            if (mutate) {
              const gate = Effect.asVoid(
                Effect.raceFirst(
                  Effect.acquireRelease(Semaphore.take(state.gate, 1), () => Semaphore.release(state.gate, 1), {
                    interruptible: true,
                  }),
                  Deferred.await(state.terminalSignal).pipe(
                    Effect.flatMap((terminal) =>
                      Effect.fail(terminalCommandError(terminal, state.fileName, method, 'not-applied')),
                    ),
                  ),
                ),
              );
              yield* interruptibleGate ? Effect.interruptible(gate) : Effect.uninterruptible(gate);
            }
            const terminal = state.terminal();
            const current = state.currentGeneration();
            if (state.isClosed() || terminal)
              return yield* Effect.fail(
                terminal
                  ? terminalCommandError(terminal, state.fileName, method, 'not-applied')
                  : new VolumeError({
                      kind: 'lifecycle',
                      fileName: state.fileName,
                      operation: method,
                      outcome: 'not-applied',
                      details: null,
                    }),
              );
            if (current !== generation) return yield* Effect.succeed({ retry: true as const });
            const old = state.continuity;
            if (mutate) {
              if (old._tag === 'lost' || (old._tag === 'pending' && old.generation !== generation)) {
                state.continuity = { _tag: 'lost', generation: old.generation };
              } else if (old._tag === 'clean') state.continuity = { _tag: 'pending', generation };
            }
            const command = Effect.suspend(() => {
              try {
                const result = run(state.backend, generation);
                return Effect.isEffect(result)
                  ? result
                  : Effect.tryPromise({ try: () => Promise.resolve(result), catch: (error) => error });
              } catch (error) {
                return Effect.fail(error);
              }
            }).pipe(Effect.map((result) => ({ retry: false as const, result })));
            return yield* mutate
              ? command.pipe(
                  Effect.catchCause((cause) => {
                    const refusal =
                      cause.reasons.length === 1 && cause.reasons[0]._tag === 'Fail'
                        ? cause.reasons[0].error
                        : undefined;
                    if (refusal instanceof VfsCommandError && refusal.dispatch === 'refused') state.continuity = old;
                    return Effect.failCause(cause);
                  }),
                )
              : command;
          }),
        );
      const attempt = mutate ? Effect.uninterruptibleMask(() => makeAttempt()) : makeAttempt();
      const exit = yield* Effect.exit(attempt);
      if (Exit.isFailure(exit)) {
        const eligibleRefusal =
          exit.cause.reasons.length === 1 && exit.cause.reasons[0]._tag === 'Fail'
            ? exit.cause.reasons[0].error
            : undefined;
        if (
          recapture &&
          recaptures === 0 &&
          state.canRecapture() &&
          eligibleRefusal instanceof VfsCommandError &&
          eligibleRefusal.dispatch === 'refused' &&
          remoteDetails(eligibleRefusal.cause).code === 'VFS_ATTACHMENT_LOST' &&
          state.currentGeneration() !== generation &&
          !state.terminal()
        ) {
          recaptures++;
          refusal = eligibleRefusal;
          differentGeneration = generation;
          continue;
        }
        return yield* Effect.failCause(
          Cause.map(exit.cause, (error) => {
            const terminal = error instanceof VfsCommandError ? state.terminal() : undefined;
            return platform(
              terminal ? terminalCommandError(terminal, state.fileName, method, commandOutcome(error, mutate)) : error,
              method,
              path,
              state.fileName,
              mutate,
            );
          }),
        );
      }
      const result = exit.value;
      if (result.retry) {
        const localRefusal = ownerChanged();
        if (
          expectedGeneration !== undefined ||
          !recapture ||
          recaptures++ >= 1 ||
          !state.canRecapture() ||
          state.terminal()
        )
          return yield* Effect.fail(platform(localRefusal, method, path, state.fileName, mutate));
        refusal = localRefusal;
        differentGeneration = undefined;
        continue;
      }
      return result.result;
    }
  });
};

const ownerChanged = () =>
  new VfsCommandError(
    Object.assign(new Error('Owner changed before dispatch'), { code: 'VFS_ATTACHMENT_LOST' }),
    'refused',
  );

const staleHandle = (state: Coordinator, method: string) =>
  PlatformError.systemError({
    _tag: 'BadResource',
    module: moduleName,
    method,
    cause: new VolumeError({
      kind: 'lifecycle',
      fileName: state.fileName,
      operation: method,
      code: 'VFS_FILE_GENERATION_CHANGED',
      outcome: 'not-applied',
      details: null,
    }),
  });

const invalidResult = (state: Coordinator, method: string, path: string, mutate = false) =>
  platform(Object.assign(new Error('Invalid result from VFS'), { code: 'EIO' }), method, path, state.fileName, mutate);

const executeHandle = <A>(
  handle: FileHandle,
  method: string,
  run: () => A | Promise<A>,
  mutate = false,
  barrier = false,
): Effect.Effect<A, PlatformError.PlatformError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const state = handle.state;
      const terminal = state.terminal();
      if (terminal) return yield* Effect.fail(platform(terminal, method, handle.path, state.fileName, mutate));
      if (handle.closed || state.isClosed() || state.currentGeneration() !== handle.generation)
        return yield* Effect.fail(staleHandle(state, method));
      return yield* Effect.scoped(
        Effect.gen(function* () {
          if (mutate)
            yield* restore(
              Effect.interruptible(
                Effect.asVoid(
                  Effect.raceFirst(
                    Effect.acquireRelease(Semaphore.take(state.gate, 1), () => Semaphore.release(state.gate, 1), {
                      interruptible: true,
                    }),
                    Deferred.await(state.terminalSignal).pipe(
                      Effect.flatMap((error) =>
                        Effect.fail(platform(error, method, handle.path, state.fileName, mutate)),
                      ),
                    ),
                  ),
                ),
              ),
            );
          const terminalAfter = state.terminal();
          if (terminalAfter)
            return yield* Effect.fail(platform(terminalAfter, method, handle.path, state.fileName, mutate));
          if (handle.closed || state.isClosed() || state.currentGeneration() !== handle.generation)
            return yield* Effect.fail(staleHandle(state, method));
          const previous = state.continuity;
          if (mutate && !barrier) {
            if (previous._tag === 'lost' || (previous._tag === 'pending' && previous.generation !== handle.generation))
              state.continuity = { _tag: 'lost', generation: previous.generation };
            else if (previous._tag === 'clean') state.continuity = { _tag: 'pending', generation: handle.generation };
          }
          const result = yield* Effect.tryPromise({ try: () => Promise.resolve(run()), catch: (error) => error }).pipe(
            Effect.catchCause((cause) => {
              const refusal =
                cause.reasons.length === 1 && cause.reasons[0]._tag === 'Fail' ? cause.reasons[0].error : undefined;
              if (mutate && !barrier && refusal instanceof VfsCommandError && refusal.dispatch === 'refused')
                state.continuity = previous;
              return Effect.failCause(
                Cause.map(cause, (error) => platform(error, method, handle.path, state.fileName, mutate)),
              );
            }),
          );
          if (barrier && state.continuity._tag === 'pending' && state.continuity.generation === handle.generation)
            state.continuity = { _tag: 'clean' };
          return result;
        }),
      );
    }),
  );

const stat = (backend: Backend, generation: string, path: string): Stat | Promise<Stat> =>
  'forGeneration' in backend ? backend.forGeneration(generation).stat(path) : backend.statSync(path);

const closeHandle = (handle: FileHandle): Promise<void> => {
  handle.closed = true;
  handle.closing ??= (async () => {
    if (!handle.openLaunched) return;
    if (handle.openingDone) await handle.openingDone;
    if (handle.fd === undefined) return;
    const backend = handle.state.backend;
    if ('forGeneration' in backend) await backend.forGeneration(handle.generation).close(handle.fd);
    else backend.closeSync(handle.fd);
  })().finally(() => {
    if (handle.release) handle.state.files.delete(handle.release);
  });
  return handle.closing;
};

const handleEffect = <A>(
  handle: FileHandle,
  method: string,
  run: (backend: Backend) => A | Promise<A>,
  mutate = false,
  barrier = false,
) => takeCursor(handle, method, () => executeHandle(handle, method, () => run(handle.state.backend), mutate, barrier));

const openHandle = (
  state: Coordinator,
  path: string,
  flag: FileSystem.OpenFlag,
  mode?: number,
  expectedGeneration?: string,
  flagsOverride?: number,
  readinessBudget?: { remaining: number },
) => {
  if (!Object.hasOwn(openFlags, flag)) return Effect.fail(badArgument('open', 'unsupported file flag'));
  if (mode !== undefined && !validMode(mode))
    return Effect.fail(badArgument('open', 'mode must be an unsigned 32-bit integer'));
  const flags = flagsOverride ?? openFlags[flag];
  const mutates = (flags & (OpenFlags.O_CREAT | OpenFlags.O_TRUNC)) !== 0;
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const pathFailure = invalidPath('open', path);
      if (pathFailure) return yield* Effect.fail(pathFailure);
      const caller = yield* Effect.scope;
      const child = yield* Scope.fork(caller, 'sequential');
      let finishOpen!: () => void;
      const handle: FileHandle = {
        state,
        fd: undefined,
        generation: '',
        path,
        append: (flags & OpenFlags.O_APPEND) !== 0,
        cursor: 0,
        cursorGate: Semaphore.makeUnsafe(1),
        closed: false,
      };
      handle.release = () =>
        Effect.tryPromise({
          try: () => closeHandle(handle),
          catch: (error) => commandMountError(error, state.fileName, 'close'),
        }).pipe(Effect.orDie);
      state.files.add(handle.release);
      yield* Scope.addFinalizer(child, handle.release());
      const unavailable = () =>
        handle.closed ||
        state.isClosed() ||
        state.scope?.state._tag === 'Closed' ||
        caller.state._tag === 'Closed' ||
        child.state._tag === 'Closed';
      const refusedOpen = () =>
        new VfsCommandError(Object.assign(new Error('File scope is closed'), { code: 'EBADF' }), 'refused');
      const closeFailed = (exit: Exit.Failure<number, PlatformError.PlatformError>) =>
        Effect.gen(function* () {
          const releaseExit = yield* Effect.exit(handle.release!());
          yield* Effect.exit(Scope.close(child, exit));
          if (Exit.isFailure(releaseExit)) return yield* Effect.failCause(Cause.combine(exit.cause, releaseExit.cause));
          return yield* Effect.failCause(exit.cause);
        });
      const failedExit = (error: PlatformError.PlatformError) =>
        Exit.fail(error) as Exit.Failure<number, PlatformError.PlatformError>;
      if (unavailable()) return yield* closeFailed(failedExit(staleHandle(state, 'open')));
      let generation = '';
      const opened = yield* Effect.exit(
        restore(
          execute(
            state,
            'open',
            path,
            (backend, current) => {
              if (unavailable()) return Effect.fail(refusedOpen());
              generation = current;
              handle.openLaunched = true;
              handle.openingDone = new Promise<void>((resolve) => {
                finishOpen = resolve;
              });
              try {
                return Promise.resolve(
                  'forGeneration' in backend
                    ? backend.forGeneration(current).open(path, flags, mode)
                    : backend.openSync(path, flags, mode),
                )
                  .then((fd) => {
                    handle.fd = fd;
                    handle.generation = current;
                    return fd;
                  })
                  .finally(finishOpen);
              } catch (error) {
                finishOpen();
                throw error;
              }
            },
            mutates,
            false,
            expectedGeneration,
            readinessBudget,
          ),
        ),
      );
      if (Exit.isSuccess(opened)) {
        handle.fd = opened.value;
        handle.generation = generation;
      }
      if (Exit.isFailure(opened)) {
        return yield* closeFailed(opened);
      }
      if (unavailable()) {
        return yield* closeFailed(
          failedExit(PlatformError.systemError({ _tag: 'BadResource', module: moduleName, method: 'open' })),
        );
      }
      return handle;
    }),
  );
};

const file = (
  state: Coordinator,
  path: string,
  flag: FileSystem.OpenFlag,
  mode?: number,
  aggregateMutatingOpen = false,
  expectedGeneration?: string,
  flagsOverride?: number,
  readinessBudget?: { remaining: number },
): Effect.Effect<FileSystem.File, PlatformError.PlatformError, import('effect').Scope.Scope> =>
  Effect.flatMap(openHandle(state, path, flag, mode, expectedGeneration, flagsOverride, readinessBudget), (handle) =>
    handle.closed
      ? Effect.fail(PlatformError.systemError({ _tag: 'BadResource', module: moduleName, method: 'open' }))
      : Effect.succeed({
          [FileSystem.FileTypeId]: FileSystem.FileTypeId,
          stat: handleEffect(handle, 'fstat', (_backend) =>
            'forGeneration' in handle.state.backend
              ? handle.state.backend.forGeneration(handle.generation).fstat(handle.fd!).then(fileInfo)
              : fileInfo(handle.state.backend.fstatSync(handle.fd!)),
          ),
          seek: (offset: bigint, from: FileSystem.SeekMode) =>
            takeCursor(handle, 'seek', () =>
              Effect.gen(function* () {
                const current = BigInt(handle.cursor);
                const nextBig = from === 'start' ? offset : current + offset;
                const next = checkedNumber(nextBig, 'seek');
                if (typeof next !== 'number') return yield* Effect.fail(next);
                if (!Number.isSafeInteger(next) || next < 0)
                  return yield* Effect.fail(badArgument('seek', 'seek position must be a non-negative safe integer'));
                handle.cursor = next;
                return BigInt(next);
              }),
            ),
          sync: handleEffect(
            handle,
            'fsync',
            (_backend) =>
              'forGeneration' in handle.state.backend
                ? handle.state.backend.forGeneration(handle.generation).fsync(handle.fd!)
                : handle.state.backend.fsyncSync(handle.fd!),
            true,
            true,
          ),
          read: (buffer: Uint8Array) => {
            if (!(buffer instanceof Uint8Array)) return Effect.fail(badArgument('read', 'buffer must be a Uint8Array'));
            return takeCursor(handle, 'read', () =>
              Effect.gen(function* () {
                const result = yield* executeHandle(handle, 'read', () => {
                  const backend = handle.state.backend;
                  return 'forGeneration' in backend
                    ? backend.forGeneration(handle.generation).read(handle.fd!, buffer.byteLength, handle.cursor)
                    : backend.readSync(handle.fd!, buffer.byteLength, handle.cursor);
                });
                if (
                  !Number.isSafeInteger(result.read) ||
                  result.read < 0 ||
                  result.read > buffer.byteLength ||
                  result.buffer.byteLength < result.read
                )
                  return yield* Effect.fail(invalidResult(handle.state, 'read', handle.path));
                buffer.set(result.buffer.subarray(0, result.read));
                handle.cursor += result.read;
                return result.read;
              }),
            );
          },
          readAlloc: (size: number) => {
            if (!Number.isSafeInteger(size) || size < 0)
              return Effect.fail(badArgument('readAlloc', 'size must be a non-negative safe integer'));
            if (size === 0) return takeCursor(handle, 'readAlloc', () => Effect.succeed(Option.none()));
            return fileReadAlloc(handle, size);
          },
          truncate: (length = 0) => {
            if (!Number.isSafeInteger(length) || length < 0)
              return Effect.fail(badArgument('truncate', 'length must be a non-negative safe integer'));
            return takeCursor(handle, 'ftruncate', () =>
              Effect.gen(function* () {
                yield* executeHandle<void>(
                  handle,
                  'ftruncate',
                  () => {
                    const backend = handle.state.backend;
                    return 'forGeneration' in backend
                      ? backend.forGeneration(handle.generation).ftruncate(handle.fd!, length)
                      : backend.ftruncateSync(handle.fd!, length);
                  },
                  true,
                );
                if (!handle.append) handle.cursor = Math.min(handle.cursor, length);
              }),
            );
          },
          write: (buffer: Uint8Array) => {
            if (!(buffer instanceof Uint8Array))
              return Effect.fail(badArgument('write', 'buffer must be a Uint8Array'));
            return Effect.suspend(() => {
              const bytes = Uint8Array.from(buffer);
              const size = bytes.byteLength;
              return takeCursor(handle, 'write', () =>
                Effect.gen(function* () {
                  const written = yield* executeHandle(
                    handle,
                    'write',
                    () => {
                      const backend = handle.state.backend;
                      return 'forGeneration' in backend
                        ? backend
                            .forGeneration(handle.generation)
                            .write(handle.fd!, bytes, handle.append ? undefined : handle.cursor)
                        : backend.writeSync(handle.fd!, bytes, handle.append ? undefined : handle.cursor);
                    },
                    true,
                    false,
                  );
                  if (!Number.isSafeInteger(written) || written < 0 || written > size)
                    return yield* Effect.fail(invalidResult(state, 'write', path, true));
                  if (!handle.append) handle.cursor += written;
                  return written;
                }),
              );
            });
          },
          writeAll: (buffer: Uint8Array) => {
            if (!(buffer instanceof Uint8Array))
              return Effect.fail(badArgument('writeAll', 'buffer must be a Uint8Array'));
            return Effect.suspend(() => {
              const bytes = Uint8Array.from(buffer);
              return takeCursor(handle, 'writeAll', () => {
                let written = 0;
                return Effect.gen(function* () {
                  while (written < bytes.byteLength) {
                    const chunk = Uint8Array.from(bytes.subarray(written, written + 64 * 1024));
                    const chunkLength = chunk.byteLength;
                    const count = yield* executeHandle(
                      handle,
                      'write',
                      () => {
                        const backend = handle.state.backend;
                        return 'forGeneration' in backend
                          ? backend
                              .forGeneration(handle.generation)
                              .write(handle.fd!, chunk, handle.append ? undefined : handle.cursor)
                          : backend.writeSync(handle.fd!, chunk, handle.append ? undefined : handle.cursor);
                      },
                      true,
                      false,
                    );
                    if (!Number.isSafeInteger(count) || count < 0 || count > chunkLength)
                      return yield* Effect.fail(invalidResult(state, 'writeAll', path, true));
                    written += count;
                    if (!handle.append) handle.cursor += count;
                    if (count === 0)
                      return yield* Effect.fail(
                        PlatformError.systemError({
                          _tag: 'WriteZero',
                          module: moduleName,
                          method: 'writeAll',
                          pathOrDescriptor: path,
                        }),
                      );
                  }
                }).pipe(
                  Effect.catchCause((cause) =>
                    written > 0 || aggregateMutatingOpen
                      ? Effect.failCause(Cause.map(cause, (error) => partialWriteFailure(state, path, error)))
                      : Effect.failCause(cause),
                  ),
                );
              });
            });
          },
        } as unknown as FileSystem.File),
  );

const fileReadAlloc = (handle: FileHandle, size: number) =>
  takeCursor(handle, 'readAlloc', () =>
    Effect.gen(function* () {
      const result = yield* executeHandle(handle, 'readAlloc', () => {
        const backend = handle.state.backend;
        return 'forGeneration' in backend
          ? backend.forGeneration(handle.generation).read(handle.fd!, size, handle.cursor)
          : backend.readSync(handle.fd!, size, handle.cursor);
      });
      if (
        !Number.isSafeInteger(result.read) ||
        result.read < 0 ||
        result.read > size ||
        result.buffer.byteLength < result.read
      )
        return yield* Effect.fail(invalidResult(handle.state, 'readAlloc', handle.path));
      if (result.read === 0) return Option.none<Uint8Array>();
      handle.cursor += result.read;
      return Option.some(Uint8Array.from(result.buffer.subarray(0, result.read)));
    }),
  );

const partialWriteFailure = (state: Coordinator, path: string, error: unknown, operation = 'writeAll') => {
  const original = PlatformError.isPlatformError(error) ? error.reason.cause : undefined;
  const cause = Schema.is(VolumeError)(original)
    ? new VolumeError({
        kind: original.kind,
        fileName: original.fileName,
        operation,
        path,
        ...(original.code === undefined ? {} : { code: original.code }),
        outcome: 'possibly-applied',
        details: original.details,
        ...(original.cause === undefined ? {} : { cause: original.cause }),
      })
    : Schema.is(EncryptionError)(original)
      ? new EncryptionError({
          reason: original.reason,
          fileName: original.fileName,
          operation,
          path,
          ...(original.code === undefined ? {} : { code: original.code }),
          outcome: 'possibly-applied',
          details: original.details,
          ...(original.cause === undefined ? {} : { cause: original.cause }),
        })
      : new VolumeError({
          kind: 'filesystem',
          fileName: state.fileName,
          operation,
          path,
          outcome: 'possibly-applied',
          details: remoteDetails(error),
          cause: error,
        });
  const details = cause.details ?? remoteDetails(error);
  const tag =
    PlatformError.isPlatformError(error) && error.reason._tag !== 'BadArgument'
      ? error.reason._tag
      : sysTag(details, cause);
  return PlatformError.systemError({
    _tag: tag,
    module: moduleName,
    method: operation,
    pathOrDescriptor: path,
    ...(details.message ? { description: details.message } : {}),
    cause,
  });
};

const joinPath = (directory: string, name: string) =>
  directory === '/' ? `/${name}` : `${directory.replace(/\/$/, '')}/${name}`;
const parentPath = (path: string) => {
  const trimmed = path.replace(/\/$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash <= 0 ? '/' : trimmed.slice(0, slash);
};
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isSymlink = (value: Stat) => (value.mode & 0o170000) === 0o120000;
const pinned = <A>(
  state: Coordinator,
  generation: string,
  method: string,
  path: string,
  run: (backend: Backend) => A | Promise<A> | Effect.Effect<A, unknown>,
  mutate = false,
  budget?: { remaining: number },
  interruptibleGate = true,
) => execute(state, method, path, (backend) => run(backend), mutate, false, generation, budget, interruptibleGate);
const pinnedLstat = (state: Coordinator, generation: string, path: string, budget?: { remaining: number }) =>
  pinned(
    state,
    generation,
    'lstat',
    path,
    (backend) => ('forGeneration' in backend ? backend.forGeneration(generation).lstat(path) : backend.lstatSync(path)),
    false,
    budget,
  );
const pinnedRealPath = (state: Coordinator, generation: string, path: string, budget?: { remaining: number }) =>
  pinned(
    state,
    generation,
    'realPath',
    path,
    (backend) =>
      'forGeneration' in backend ? backend.forGeneration(generation).realpath(path) : backend.realpathSync(path),
    false,
    budget,
  );
const pinnedStat = (state: Coordinator, generation: string, path: string, budget?: { remaining: number }) =>
  pinned(
    state,
    generation,
    'stat',
    path,
    (backend) => ('forGeneration' in backend ? backend.forGeneration(generation).stat(path) : backend.statSync(path)),
    false,
    budget,
  );
const pinnedRemove = (state: Coordinator, generation: string, path: string, budget?: { remaining: number }) =>
  pinned(
    state,
    generation,
    'remove',
    path,
    (backend) =>
      'forGeneration' in backend ? backend.forGeneration(generation).remove(path) : backend.removeSync(path),
    true,
    budget,
    false,
  );
const pinnedLookup = (state: Coordinator, generation: string, path: string, budget?: { remaining: number }) =>
  Effect.result(pinnedLstat(state, generation, path, budget)).pipe(
    Effect.flatMap((result) =>
      result._tag === 'Success'
        ? Effect.succeed(Option.some(result.success))
        : result.failure.reason._tag === 'NotFound'
          ? Effect.succeed(Option.none<Stat>())
          : Effect.fail(result.failure),
    ),
  );

const resolveCopyParent = (state: Coordinator, generation: string, path: string, budget: { remaining: number }) =>
  Effect.gen(function* () {
    let cursor = path;
    const missing: Array<string> = [];
    while (true) {
      const entry = yield* pinnedLookup(state, generation, cursor, budget);
      if (Option.isSome(entry)) {
        const realPath = yield* pinnedRealPath(state, generation, cursor, budget);
        const resolved = yield* pinnedStat(state, generation, realPath, budget);
        if (!resolved.is_dir) return yield* Effect.fail(badArgument('copy', 'destination parent is not a directory'));
        return { realPath, missing: missing.reverse() };
      }
      if (cursor === '/') return yield* Effect.fail(badArgument('copy', 'destination parent does not exist'));
      missing.push(baseName(cursor));
      cursor = parentPath(cursor);
    }
  });

const copyFilePinned = (
  state: Coordinator,
  generation: string,
  fromPath: string,
  toPath: string,
  budget: { remaining: number },
) => {
  let possiblyChanged = false;
  return Effect.scoped(
    Effect.gen(function* () {
      const source = yield* file(state, fromPath, 'r', undefined, false, generation, undefined, budget);
      const destination = yield* file(
        state,
        toPath,
        'w',
        undefined,
        false,
        generation,
        OpenFlags.O_WRONLY | OpenFlags.O_CREAT,
        budget,
      );
      possiblyChanged = true;
      const [sourceInfo, destinationInfo] = yield* Effect.all([source.stat, destination.stat]);
      const sourceIno = sourceInfo.ino._tag === 'Some' ? sourceInfo.ino.value : undefined;
      const destinationIno = destinationInfo.ino._tag === 'Some' ? destinationInfo.ino.value : undefined;
      if (sourceIno === undefined || destinationIno === undefined)
        return yield* Effect.fail(invalidResult(state, 'copyFile', fromPath));
      if (sourceIno === destinationIno) {
        possiblyChanged = false;
        return yield* Effect.fail(badArgument('copyFile', 'source and destination refer to the same file'));
      }
      yield* destination.truncate(0);
      while (true) {
        const chunk = yield* source.readAlloc(64 * 1024);
        if (Option.isNone(chunk)) return;
        yield* destination.writeAll(chunk.value);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        !possiblyChanged
          ? Effect.failCause(cause)
          : Effect.failCause(
              Cause.map(cause, (error) => {
                return partialWriteFailure(state, toPath, error, 'copyFile');
              }),
            ),
      ),
    ),
  );
};

const copyPinned = (
  state: Coordinator,
  generation: string,
  fromPath: string,
  toPath: string,
  overwrite: boolean,
  preserveTimestamps: boolean,
  budget: { remaining: number },
) => {
  let changed = false;
  return Effect.gen(function* () {
    const sourceRoot = yield* pinnedLstat(state, generation, fromPath, budget);
    const sourceReal = sourceRoot.is_dir
      ? yield* pinnedRealPath(state, generation, fromPath, budget)
      : joinPath(yield* pinnedRealPath(state, generation, parentPath(fromPath), budget), baseName(fromPath));
    const destinationParent = yield* resolveCopyParent(state, generation, parentPath(toPath), budget);
    const existingDestination = yield* pinnedLookup(state, generation, toPath, budget);
    const destinationReal =
      Option.isSome(existingDestination) && existingDestination.value.is_dir && !isSymlink(existingDestination.value)
        ? yield* pinnedRealPath(state, generation, toPath, budget)
        : joinPath(destinationParent.missing.reduce(joinPath, destinationParent.realPath), baseName(toPath));
    if (
      destinationReal === sourceReal ||
      (sourceRoot.is_dir && destinationReal.startsWith(`${sourceReal.replace(/\/$/, '')}/`))
    )
      return yield* Effect.fail(badArgument('copy', 'destination is the source or is inside it'));
    if (destinationParent.missing.length > 0) {
      yield* pinned(
        state,
        generation,
        'makeDirectory',
        parentPath(toPath),
        (backend) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).mkdir(parentPath(toPath), { recursive: true })
            : backend.mkdirSync(parentPath(toPath), { recursive: true }),
        true,
        budget,
      );
      changed = true;
    }

    const timestamps = (stat: Stat, destinationPath: string): Effect.Effect<void, PlatformError.PlatformError> => {
      if (!preserveTimestamps) return Effect.void;
      const atime = stat.atimeMs ?? stat.timestampMs;
      const mtime = stat.mtimeMs ?? stat.timestampMs;
      if (atime === undefined || mtime === undefined) return Effect.void;
      return pinned(
        state,
        generation,
        'utimes',
        destinationPath,
        (backend) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).utimes(destinationPath, atime, mtime)
            : backend.utimesSync(destinationPath, atime, mtime),
        true,
        budget,
      ).pipe(Effect.tap(() => Effect.sync(() => (changed = true))));
    };
    const copyEntry = (sourcePath: string, destinationPath: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const source = yield* pinnedLstat(state, generation, sourcePath, budget);
        const destinationResult = yield* pinnedLookup(state, generation, destinationPath, budget);
        const destination = Option.getOrUndefined(destinationResult);
        const sourceLink = isSymlink(source);
        const compatible =
          destination !== undefined &&
          ((source.is_dir && destination.is_dir) ||
            (source.is_file && (destination.is_file || isSymlink(destination))) ||
            (sourceLink && isSymlink(destination)));
        if (destination && !compatible)
          if (sourceLink && !isSymlink(destination))
            return yield* Effect.fail(
              platform(
                Object.assign(new Error('Destination already exists'), { code: 'EEXIST' }),
                'copy',
                destinationPath,
                state.fileName,
              ),
            );
        if (destination && !compatible)
          return yield* Effect.fail(badArgument('copy', 'source and destination have incompatible types'));
        if (destination && !overwrite && !source.is_dir) return;

        if (sourceLink) {
          if (destination && overwrite) {
            yield* pinned(
              state,
              generation,
              'remove',
              destinationPath,
              (backend) =>
                'forGeneration' in backend
                  ? backend.forGeneration(generation).unlink(destinationPath)
                  : backend.unlinkSync(destinationPath),
              true,
              budget,
            );
            changed = true;
          }
          if (!destination || overwrite) {
            const target = yield* pinned(
              state,
              generation,
              'readLink',
              sourcePath,
              (backend) =>
                'forGeneration' in backend
                  ? backend.forGeneration(generation).readlink(sourcePath)
                  : backend.readlinkSync(sourcePath),
              false,
              budget,
            );
            yield* pinned(
              state,
              generation,
              'symlink',
              destinationPath,
              (backend) =>
                'forGeneration' in backend
                  ? backend.forGeneration(generation).symlink(target, destinationPath)
                  : backend.symlinkSync(target, destinationPath),
              true,
              budget,
            );
            changed = true;
          }
          return;
        }
        if (source.is_dir) {
          if (!destination)
            yield* pinned(
              state,
              generation,
              'makeDirectory',
              destinationPath,
              (backend) =>
                'forGeneration' in backend
                  ? backend.forGeneration(generation).mkdir(destinationPath, { mode: (source.mode & 0o7777) | 0o700 })
                  : backend.mkdirSync(destinationPath, { mode: (source.mode & 0o7777) | 0o700 }),
              true,
              budget,
            );
          if (!destination) changed = true;
          const entries = yield* pinned(
            state,
            generation,
            'readDirectory',
            sourcePath,
            (backend) =>
              'forGeneration' in backend
                ? backend.forGeneration(generation).readdirEntries(sourcePath)
                : backend.readdirEntriesSync(sourcePath),
            false,
            budget,
          );
          for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name)))
            yield* copyEntry(joinPath(sourcePath, entry.name), joinPath(destinationPath, entry.name));
          if (!destination || overwrite) {
            yield* pinned(
              state,
              generation,
              'chmod',
              destinationPath,
              (backend) =>
                'forGeneration' in backend
                  ? backend.forGeneration(generation).chmod(destinationPath, source.mode & 0o7777)
                  : backend.chmodSync(destinationPath, source.mode & 0o7777),
              true,
              budget,
            );
            changed = true;
            yield* timestamps(source, destinationPath);
          }
          return;
        }
        if (source.is_file) {
          if (!destination || overwrite) {
            if (destination && destination.is_file && source.ino === destination.ino)
              return yield* Effect.fail(badArgument('copy', 'source and destination refer to the same file'));
            if (destination) {
              yield* pinned(
                state,
                generation,
                'remove',
                destinationPath,
                (backend) =>
                  'forGeneration' in backend
                    ? backend.forGeneration(generation).unlink(destinationPath)
                    : backend.unlinkSync(destinationPath),
                true,
                budget,
              );
              changed = true;
            }
            yield* copyFilePinned(state, generation, sourcePath, destinationPath, budget);
            changed = true;
            yield* pinned(
              state,
              generation,
              'chmod',
              destinationPath,
              (backend) =>
                'forGeneration' in backend
                  ? backend.forGeneration(generation).chmod(destinationPath, source.mode & 0o7777)
                  : backend.chmodSync(destinationPath, source.mode & 0o7777),
              true,
              budget,
            );
            changed = true;
            yield* timestamps(source, destinationPath);
          }
          return;
        }
        return yield* Effect.fail(badArgument('copy', 'unsupported source entry type'));
      });
    if (sourceRoot.is_dir && Option.isSome(existingDestination) && existingDestination.value.is_dir) {
      for (const entry of yield* pinned(
        state,
        generation,
        'readDirectory',
        fromPath,
        (backend) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).readdirEntries(fromPath)
            : backend.readdirEntriesSync(fromPath),
        false,
        budget,
      ))
        yield* copyEntry(joinPath(fromPath, entry.name), joinPath(toPath, entry.name));
      if (overwrite) {
        yield* pinned(
          state,
          generation,
          'chmod',
          toPath,
          (backend) =>
            'forGeneration' in backend
              ? backend.forGeneration(generation).chmod(toPath, sourceRoot.mode & 0o7777)
              : backend.chmodSync(toPath, sourceRoot.mode & 0o7777),
          true,
          budget,
        );
        changed = true;
        yield* timestamps(sourceRoot, toPath);
      }
    } else {
      yield* copyEntry(fromPath, toPath);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      changed
        ? Effect.failCause(Cause.map(cause, (error) => partialWriteFailure(state, toPath, error, 'copy')))
        : Effect.failCause(cause),
    ),
  );
};

const validTempPart = (value: unknown) => typeof value === 'string' && !value.includes('/') && !value.includes('\0');
const randomHex = () => {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
const alreadyExists = (error: PlatformError.PlatformError) => error.reason._tag === 'AlreadyExists';

interface TempResource {
  readonly path: string;
  readonly root: string;
  readonly generation: string;
  readonly owner: TempOwner;
}

interface TempOwner {
  readonly child: Scope.Closeable;
  readonly state: Coordinator;
  generation: string;
  root?: string;
  created: boolean;
  mutated: boolean;
  started: boolean;
  detached: boolean;
  closing: boolean;
  cleanupBudget?: { remaining: number };
  allocationDone: Promise<void>;
  finishAllocation: () => void;
  readonly release: () => Effect.Effect<void>;
  readonly detach: Effect.Effect<void, PlatformError.PlatformError>;
}

const makeTempOwner = (
  state: Coordinator,
  generation: string,
  parent: Scope.Scope,
  cleanupBudget: { remaining: number },
): Effect.Effect<TempOwner, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    if (parent.state._tag === 'Closed') return yield* Effect.fail(staleHandle(state, 'makeTemp'));
    const child = yield* Scope.fork(parent, 'sequential');
    let finishAllocation!: () => void;
    const allocationDone = new Promise<void>((resolve) => {
      finishAllocation = resolve;
    });
    let owner!: TempOwner;
    let cachedRelease!: Effect.Effect<void>;
    let release!: () => Effect.Effect<void>;
    const releaseBase = Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        owner.closing = true;
        if (owner.started) yield* Effect.tryPromise({ try: () => allocationDone, catch: (error) => error });
        if (owner.created && owner.root && !owner.detached)
          yield* pinnedRemove(
            state,
            generation,
            owner.root,
            owner.cleanupBudget ?? { remaining: state.readinessTimeout },
          );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            state.files.delete(release);
          }),
        ),
        Effect.orDie,
      ),
    );
    release = () => cachedRelease;
    cachedRelease = yield* Effect.cached(releaseBase);
    const detach = Effect.uninterruptible(
      Effect.gen(function* () {
        if (child.state._tag === 'Closed' || owner.closing) return yield* Effect.fail(staleHandle(state, 'makeTemp'));
        owner.detached = true;
        owner.created = false;
        owner.root = undefined;
        const finalizers = Scope.closeUnsafe(child, Exit.succeed(undefined));
        if (finalizers) yield* finalizers;
      }),
    );
    owner = {
      child,
      state,
      generation,
      created: false,
      mutated: false,
      started: false,
      detached: false,
      closing: false,
      cleanupBudget,
      get allocationDone() {
        return allocationDone;
      },
      finishAllocation: () => finishAllocation(),
      release,
      detach,
    };
    state.files.add(release);
    yield* Scope.addFinalizer(child, release());
    if (child.state._tag === 'Closed') return yield* Effect.fail(staleHandle(state, 'makeTemp'));
    return owner;
  });

const allocateTemp = (
  state: Coordinator,
  method: string,
  directory: string,
  parent: Scope.Scope,
  scoped: boolean,
  budget: { remaining: number },
  allocate: (generation: string, owner: TempOwner) => Effect.Effect<TempResource, PlatformError.PlatformError>,
): Effect.Effect<TempResource, PlatformError.PlatformError> =>
  Effect.suspend(() =>
    execute(
      state,
      method,
      directory,
      (_backend, generation) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const owner = yield* makeTempOwner(state, generation, parent, budget);
            owner.generation = generation;
            owner.started = true;
            const allocation = yield* Effect.exit(
              restore(allocate(generation, owner)).pipe(Effect.ensuring(Effect.sync(owner.finishAllocation))),
            );
            if (Exit.isFailure(allocation)) {
              const cleanup = yield* Effect.exit(owner.release());
              yield* Effect.exit(Scope.close(owner.child, allocation));
              const primary = owner.mutated
                ? Cause.map(allocation.cause, (error) =>
                    partialWriteFailure(state, owner.root ?? directory, error, method),
                  )
                : allocation.cause;
              return Exit.isFailure(cleanup)
                ? yield* Effect.failCause(Cause.combine(primary, cleanup.cause))
                : yield* Effect.failCause(primary);
            }
            if (state.isClosed() || owner.child.state._tag === 'Closed' || owner.closing) {
              const failureCause = Cause.fail(staleHandle(state, method));
              const cleanup = yield* Effect.exit(owner.release());
              yield* Effect.exit(Scope.close(owner.child, Exit.failCause(failureCause)));
              const primary = owner.mutated
                ? Cause.map(failureCause, (error) => partialWriteFailure(state, owner.root ?? directory, error, method))
                : failureCause;
              return Exit.isFailure(cleanup)
                ? yield* Effect.failCause(Cause.combine(primary, cleanup.cause))
                : yield* Effect.failCause(primary);
            }
            if (!scoped) yield* owner.detach;
            else owner.cleanupBudget = undefined;
            return allocation.value;
          }),
        ),
      false,
      false,
      undefined,
      budget,
    ),
  );

const tempDirectoryResource = (
  state: Coordinator,
  method: string,
  options: { readonly directory?: string; readonly prefix?: string } | undefined,
  parent: Scope.Scope,
  scoped: boolean,
): Effect.Effect<TempResource, PlatformError.PlatformError> => {
  const directory = options?.directory ?? '/tmp';
  const prefix = options?.prefix ?? '';
  const invalid =
    invalidPath(method, directory) ??
    (!validTempPart(prefix) ? badArgument(method, 'prefix must be a single path component') : undefined);
  if (invalid) return Effect.fail(invalid);
  return Effect.suspend(() => {
    const budget = { remaining: state.readinessTimeout };
    return allocateTemp(state, method, directory, parent, scoped, budget, (generation, owner) =>
      Effect.gen(function* () {
        yield* pinned(
          state,
          generation,
          'makeDirectory',
          directory,
          (backend) =>
            'forGeneration' in backend
              ? backend.forGeneration(generation).mkdir(directory, { recursive: true })
              : backend.mkdirSync(directory, { recursive: true }),
          true,
          budget,
        );
        owner.mutated = true;
        const physicalDirectory = yield* pinnedRealPath(state, generation, directory, budget);
        let lastError: PlatformError.PlatformError | undefined;
        for (let attempt = 0; attempt < 128; attempt++) {
          const path = joinPath(physicalDirectory, `${prefix}${randomHex()}`);
          const created = yield* Effect.result(
            pinned(
              state,
              generation,
              method,
              path,
              (backend) => {
                if ('forGeneration' in backend)
                  return backend
                    .forGeneration(generation)
                    .mkdir(path)
                    .then(() => {
                      owner.root = path;
                      owner.created = true;
                    });
                backend.mkdirSync(path);
                owner.root = path;
                owner.created = true;
              },
              true,
              budget,
            ),
          );
          if (created._tag === 'Success') {
            owner.root = path;
            owner.created = true;
            owner.mutated = true;
            return { path, root: path, generation, owner };
          }
          lastError = created.failure;
          if (!alreadyExists(lastError)) return yield* Effect.fail(lastError);
        }
        return yield* Effect.fail(lastError!);
      }),
    );
  });
};

const tempFileResource = (
  state: Coordinator,
  method: string,
  options: { readonly directory?: string; readonly prefix?: string; readonly suffix?: string } | undefined,
  parent: Scope.Scope,
  scoped: boolean,
): Effect.Effect<TempResource, PlatformError.PlatformError> => {
  const directory = options?.directory ?? '/tmp';
  const prefix = options?.prefix ?? '';
  const suffix = options?.suffix ?? '';
  const invalid =
    invalidPath(method, directory) ??
    (!validTempPart(prefix) || !validTempPart(suffix)
      ? badArgument(method, 'prefix and suffix must be single path components')
      : undefined);
  if (invalid) return Effect.fail(invalid);
  return Effect.suspend(() => {
    const budget = { remaining: state.readinessTimeout };
    return allocateTemp(state, method, directory, parent, scoped, budget, (generation, owner) =>
      Effect.gen(function* () {
        yield* pinned(
          state,
          generation,
          'makeDirectory',
          directory,
          (backend) =>
            'forGeneration' in backend
              ? backend.forGeneration(generation).mkdir(directory, { recursive: true })
              : backend.mkdirSync(directory, { recursive: true }),
          true,
          budget,
        );
        owner.mutated = true;
        const physicalDirectory = yield* pinnedRealPath(state, generation, directory, budget);
        let lastError: PlatformError.PlatformError | undefined;
        for (let attempt = 0; attempt < 128; attempt++) {
          const root = joinPath(physicalDirectory, `${prefix}${randomHex()}`);
          const madeDirectory = yield* Effect.result(
            pinned(
              state,
              generation,
              method,
              root,
              (backend) => {
                if ('forGeneration' in backend)
                  return backend
                    .forGeneration(generation)
                    .mkdir(root)
                    .then(() => {
                      owner.root = root;
                      owner.created = true;
                    });
                backend.mkdirSync(root);
                owner.root = root;
                owner.created = true;
              },
              true,
              budget,
            ),
          );
          if (madeDirectory._tag === 'Failure') {
            lastError = madeDirectory.failure;
            if (alreadyExists(lastError)) continue;
            return yield* Effect.fail(lastError);
          }
          owner.root = root;
          owner.created = true;
          owner.mutated = true;
          const path = joinPath(root, `${randomHex()}${suffix}`);
          const opened = yield* Effect.exit(
            Effect.scoped(
              Effect.asVoid(
                file(
                  state,
                  path,
                  'wx',
                  undefined,
                  false,
                  generation,
                  OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_EXCL,
                  budget,
                ),
              ),
            ),
          );
          if (Exit.isSuccess(opened)) return { path, root, generation, owner };
          const openFailure =
            opened.cause.reasons.length === 1 && opened.cause.reasons[0]._tag === 'Fail'
              ? opened.cause.reasons[0].error
              : undefined;
          if (!PlatformError.isPlatformError(openFailure) || !alreadyExists(openFailure))
            return yield* Effect.failCause(opened.cause);
          const cleanup = yield* Effect.exit(pinnedRemove(state, generation, root, budget));
          if (Exit.isFailure(cleanup)) return yield* Effect.failCause(Cause.combine(opened.cause, cleanup.cause));
          owner.root = undefined;
          owner.created = false;
          lastError = openFailure;
        }
        return yield* Effect.fail(lastError!);
      }),
    );
  });
};

const readFileDescriptor = (state: Coordinator, backend: Backend, generation: string, path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fd = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () =>
            'forGeneration' in backend
              ? await backend.forGeneration(generation).open(path, OpenFlags.O_RDONLY)
              : backend.openSync(path, OpenFlags.O_RDONLY),
          catch: (error) => error,
        }),
        (value) =>
          ('forGeneration' in backend
            ? Effect.tryPromise({
                try: () => backend.forGeneration(generation).close(value),
                catch: (error) => commandMountError(error, state.fileName, 'readFile'),
              })
            : Effect.try({
                try: () => backend.closeSync(value),
                catch: (error) => commandMountError(error, state.fileName, 'readFile'),
              })
          ).pipe(Effect.orDie),
      );
      const info = yield* Effect.tryPromise({
        try: async () =>
          'forGeneration' in backend ? await backend.forGeneration(generation).fstat(fd) : backend.fstatSync(fd),
        catch: (error) => error,
      });
      if (!Number.isSafeInteger(info.size) || info.size < 0)
        return yield* Effect.fail(
          mountError(
            Object.assign(new Error('File size is outside the supported range'), { code: 'EFBIG' }),
            state.fileName,
            'readFile',
          ),
        );
      const bytes = yield* Effect.try({
        try: () => new Uint8Array(info.size),
        catch: (error) => error,
      });
      let offset = 0;
      while (offset < bytes.byteLength) {
        const size = Math.min(64 * 1024, bytes.byteLength - offset);
        const result = yield* Effect.tryPromise({
          try: async () =>
            'forGeneration' in backend
              ? await backend.forGeneration(generation).read(fd, size, offset)
              : backend.readSync(fd, size, offset),
          catch: (error) => error,
        });
        if (
          !Number.isSafeInteger(result.read) ||
          result.read <= 0 ||
          result.read > size ||
          result.buffer.byteLength < result.read
        )
          return yield* Effect.fail(
            mountError(
              Object.assign(new Error('Incomplete whole-file read'), { code: 'EIO' }),
              state.fileName,
              'readFile',
            ),
          );
        bytes.set(result.buffer.subarray(0, result.read), offset);
        offset += result.read;
      }
      return bytes;
    }),
  );

const openFlags: Record<FileSystem.OpenFlag, number> = {
  r: OpenFlags.O_RDONLY,
  'r+': OpenFlags.O_RDWR,
  w: OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_TRUNC,
  wx: OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_TRUNC | OpenFlags.O_EXCL,
  'w+': OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_TRUNC,
  'wx+': OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_TRUNC | OpenFlags.O_EXCL,
  a: OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_APPEND,
  ax: OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_APPEND | OpenFlags.O_EXCL,
  'a+': OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_APPEND,
  'ax+': OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_APPEND | OpenFlags.O_EXCL,
};

const validMode = (mode: unknown): mode is number =>
  typeof mode === 'number' && Number.isFinite(mode) && Number.isInteger(mode) && mode >= 0 && mode <= 0xffffffff;

const validTime = (value: Date | number): number | PlatformError.PlatformError => {
  if (!(value instanceof Date) && typeof value !== 'number')
    return badArgument('utimes', 'time must be a Date or number');
  let milliseconds: number;
  try {
    milliseconds = value instanceof Date ? Date.prototype.getTime.call(value) : value * 1000;
  } catch {
    return badArgument('utimes', 'time must be a valid Date or number');
  }
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15
    ? milliseconds
    : badArgument('utimes', 'time must be a finite value within the supported date range');
};

const isMissing = (error: unknown) =>
  remoteDetails(error instanceof VfsCommandError ? error.cause : error).code === 'ENOENT';

interface FileHandle {
  readonly state: Coordinator;
  fd?: number;
  generation: string;
  readonly path: string;
  readonly append: boolean;
  cursor: number;
  readonly cursorGate: Semaphore.Semaphore;
  closed: boolean;
  closing?: Promise<void>;
  openingDone?: Promise<void>;
  openLaunched?: boolean;
  release?: () => Effect.Effect<void>;
}

const badArgument = (method: string, description: string) =>
  PlatformError.badArgument({ module: moduleName, method, description });

const fileInfo = (value: VfsStat): FileSystem.File.Info => {
  if (!validMode(value.mode) || !Number.isSafeInteger(value.size) || value.size < 0)
    throw badArgument('stat', 'file metadata is outside the supported range');
  const optionalNumber = (number: number | undefined) =>
    number !== undefined && Number.isSafeInteger(number) && number >= 0 ? Option.some(number) : Option.none();
  const date = (number: number | undefined) => {
    const value = number === undefined ? undefined : new Date(number);
    return value && Number.isFinite(value.getTime()) ? Option.some(value) : Option.none();
  };
  const kind = value.mode & 0o170000;
  return {
    type: value.is_file ? 'File' : value.is_dir ? 'Directory' : kind === 0o120000 ? 'SymbolicLink' : 'Unknown',
    mtime: date(value.mtimeMs ?? value.timestampMs),
    atime: date(value.atimeMs ?? value.timestampMs),
    birthtime: Option.none(),
    dev: 0,
    ino: optionalNumber(value.ino),
    mode: value.mode,
    nlink: optionalNumber(value.nlink),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: ByteSize.bytes(BigInt(value.size)),
    blksize: optionalNumber(value.blksize).pipe(Option.map(ByteSize.bytes)),
    blocks: optionalNumber(value.blocks),
  };
};

const checkedNumber = (value: bigint, method: string): number | PlatformError.PlatformError => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? number
    : badArgument(method, 'offset is outside the supported range');
};

const stateIsClosed = (handle: FileHandle) => handle.state.isClosed();

const takeCursor = <A>(handle: FileHandle, method: string, run: () => Effect.Effect<A, PlatformError.PlatformError>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Semaphore.take(handle.cursorGate, 1),
        () => Semaphore.release(handle.cursorGate, 1),
        { interruptible: true },
      );
      const terminal = handle.state.terminal();
      if (terminal) return yield* Effect.fail(platform(terminal, method, handle.path, handle.state.fileName));
      if (handle.closed || stateIsClosed(handle) || handle.state.currentGeneration() !== handle.generation)
        return yield* Effect.fail(PlatformError.systemError({ _tag: 'BadResource', module: moduleName, method }));
      return yield* run();
    }),
  );

const make = (volume: VolumeService): FileSystem.FileSystem => {
  const state = getCoordinator(volume);
  if (!state) throw new TypeError('Volume service was not created by this adapter');
  const watch = (path: string, options?: FileSystem.WatchOptions) =>
    Stream.suspend(() => {
      const pathFailure = invalidPath('watch', path);
      if (pathFailure) return Stream.fail(pathFailure);
      const acquire = Effect.gen(function* () {
        const budget = { remaining: state.readinessTimeout };
        const generation = yield* state
          .awaitReady(budget, 'watch')
          .pipe(Effect.mapError((error) => watchFailure(state, path, error)));
        const target = yield* pinnedLstat(state, generation, path, budget).pipe(
          Effect.mapError((error) => watchFailure(state, path, error)),
        );
        if (isSymlink(target))
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: 'BadResource',
              module: moduleName,
              method: 'watch',
              pathOrDescriptor: path,
              cause: new VolumeError({
                kind: 'filesystem',
                fileName: state.fileName,
                operation: 'watch',
                path,
                code: 'ELOOP',
                outcome: 'not-applied',
                details: remoteDetails(Object.assign(new Error('Cannot watch a symlink target'), { code: 'ELOOP' })),
              }),
            }),
          );
        if (!target.is_dir && !target.is_file)
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: 'BadResource',
              module: moduleName,
              method: 'watch',
              pathOrDescriptor: path,
              cause: new VolumeError({
                kind: 'filesystem',
                fileName: state.fileName,
                operation: 'watch',
                path,
                code: 'EINVAL',
                outcome: 'not-applied',
                details: remoteDetails(Object.assign(new Error('Target is not a regular file or directory'), { code: 'EINVAL' })),
              }),
            }),
          );
        const admission: SubscriptionAdmission = { generation, budget };
        const subscription = yield* makeSubscriptionInternal(
          state,
          {
            path,
            scope: target.is_dir ? 'directory' : 'file',
            recursive: target.is_dir && (options?.recursive ?? false),
            content: false,
          },
          admission,
        ).pipe(
          Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, (error) => watchFailure(state, path, error)))),
        );
        return subscription.changes.pipe(
          Stream.catchCause((cause) =>
            Stream.failCause(Cause.map(cause, (error) => watchFailure(state, path, error))),
          ),
          Stream.map((change): FileSystem.WatchEvent => {
            switch (change.type) {
              case 'create':
                return { _tag: 'Create', path: change.path };
              case 'update':
                return { _tag: 'Update', path: change.path };
              case 'delete':
                return { _tag: 'Remove', path: change.path };
            }
          }),
        );
      });
      return Stream.scoped(
        Stream.unwrap(
          acquire.pipe(
            Effect.catchCause((cause) =>
              Effect.failCause(Cause.map(cause, (error) => watchFailure(state, path, error))),
            ),
          ),
        ),
      );
    });
  const fs = FileSystem.make({
    access: (path, options) =>
      (options?.ok !== undefined && typeof options.ok !== 'boolean') ||
      (options?.readable !== undefined && typeof options.readable !== 'boolean') ||
      (options?.writable !== undefined && typeof options.writable !== 'boolean')
        ? Effect.fail(badArgument('access', 'ok, readable, and writable must be booleans'))
        : execute(state, 'access', path, async (backend, generation) => {
            const info = await stat(backend, generation, path);
            const read = (info.mode & 0o444) !== 0;
            const write = (info.mode & 0o222) !== 0;
            if ((options?.readable && !read) || (options?.writable && !write))
              throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
          }),
    chmod: (path, mode) =>
      !validMode(mode)
        ? Effect.fail(badArgument('chmod', 'mode must be an unsigned 32-bit integer'))
        : execute(
            state,
            'chmod',
            path,
            (backend, generation) =>
              'forGeneration' in backend
                ? backend.forGeneration(generation).chmod(path, mode)
                : backend.chmodSync(path, mode),
            true,
          ),
    chown: (path) => Effect.fail(invalidPath('chown', path) ?? unsupported('chown', path, state.fileName)),
    glob: (pattern, options) => {
      const rootFailure = options?.root === undefined ? undefined : invalidPath('glob', options.root);
      return Effect.fail(rootFailure ?? unsupported('glob', pattern, state.fileName));
    },
    link: (existingPath, newPath) => {
      const existingFailure = invalidPath('link', existingPath);
      const newFailure = invalidPath('link', newPath);
      if (existingFailure || newFailure) return Effect.fail(existingFailure ?? newFailure!);
      return execute(
        state,
        'link',
        existingPath,
        (backend, generation) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).link(existingPath, newPath)
            : backend.linkSync(existingPath, newPath),
        true,
      );
    },
    makeDirectory: (path, options) => {
      if (options?.recursive !== undefined && typeof options.recursive !== 'boolean')
        return Effect.fail(badArgument('makeDirectory', 'recursive must be a boolean'));
      if (options?.mode !== undefined && !validMode(options.mode))
        return Effect.fail(badArgument('makeDirectory', 'mode must be an unsigned 32-bit integer'));
      const mode = options?.mode;
      const recursive = options?.recursive ?? false;
      return execute(
        state,
        'makeDirectory',
        path,
        (backend, generation) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).mkdir(path, { mode, recursive })
            : backend.mkdirSync(path, { mode, recursive }),
        true,
      );
    },
    makeTempDirectory: (options) =>
      Effect.scoped(
        Effect.flatMap(Effect.scope, (parent) =>
          Effect.map(
            tempDirectoryResource(state, 'makeTempDirectory', options, parent, false),
            (resource) => resource.path,
          ),
        ),
      ),
    makeTempDirectoryScoped: (options) =>
      Effect.flatMap(Effect.scope, (parent) =>
        Effect.map(
          tempDirectoryResource(state, 'makeTempDirectoryScoped', options, parent, true),
          (resource) => resource.path,
        ),
      ),
    makeTempFile: (options) =>
      Effect.scoped(
        Effect.flatMap(Effect.scope, (parent) =>
          Effect.map(tempFileResource(state, 'makeTempFile', options, parent, false), (resource) => resource.path),
        ),
      ),
    makeTempFileScoped: (options) =>
      Effect.flatMap(Effect.scope, (parent) =>
        Effect.map(tempFileResource(state, 'makeTempFileScoped', options, parent, true), (resource) => resource.path),
      ),
    readFile: (path) =>
      execute(
        state,
        'readFile',
        path,
        (backend, generation) => {
          const fallback = () => readFileDescriptor(state, backend, generation, path);
          if (!('forGeneration' in backend)) return fallback();
          return Effect.tryPromise({
            try: () => backend.forGeneration(generation).readFileBuffer(path, maxWholeFileBytes),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              remoteDetails(error instanceof VfsCommandError ? error.cause : error).code === 'EFBIG'
                ? fallback()
                : Effect.fail(error),
            ),
          );
        },
        false,
        false,
      ),
    writeFile: (path, bytes, options) => {
      const pathFailure = invalidPath('writeFile', path);
      if (pathFailure) return Effect.fail(pathFailure);
      if (!(bytes instanceof Uint8Array))
        return Effect.fail(
          PlatformError.badArgument({
            module: moduleName,
            method: 'writeFile',
            description: 'data must be a Uint8Array',
          }),
        );
      const flag = options?.flag ?? 'w';
      if (!Object.hasOwn(openFlags, flag)) return Effect.fail(badArgument('writeFile', 'unsupported file flag'));
      if (options?.mode !== undefined && !validMode(options.mode))
        return Effect.fail(badArgument('writeFile', 'mode must be an unsigned 32-bit integer'));
      if (options?.mode !== undefined || bytes.byteLength > maxWholeFileBytes || !['w', 'wx', 'ax'].includes(flag)) {
        return Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* file(
              state,
              path,
              flag,
              options?.mode,
              (openFlags[flag] & (OpenFlags.O_CREAT | OpenFlags.O_TRUNC)) !== 0,
            );
            yield* opened.writeAll(bytes);
          }),
        );
      }
      return execute(
        state,
        'writeFile',
        path,
        (backend, generation) => {
          const writeOptions = { exclusive: flag === 'wx' || flag === 'ax', append: flag === 'ax' };
          if ('forGeneration' in backend)
            return backend.forGeneration(generation).writeFileBuffer(path, bytes, writeOptions);
          backend.writeFileBufferSync(path, bytes, writeOptions);
        },
        true,
      );
    },
    copy: (fromPath, toPath, options) => {
      const fromFailure = invalidPath('copy', fromPath);
      const toFailure = invalidPath('copy', toPath);
      if (fromFailure || toFailure) return Effect.fail(fromFailure ?? toFailure!);
      if (options?.overwrite !== undefined && typeof options.overwrite !== 'boolean')
        return Effect.fail(badArgument('copy', 'overwrite must be a boolean'));
      if (options?.preserveTimestamps !== undefined && typeof options.preserveTimestamps !== 'boolean')
        return Effect.fail(badArgument('copy', 'preserveTimestamps must be a boolean'));
      return Effect.suspend(() => {
        const budget = { remaining: state.readinessTimeout };
        return execute(
          state,
          'copy',
          fromPath,
          (_backend, generation) =>
            copyPinned(
              state,
              generation,
              fromPath,
              toPath,
              options?.overwrite ?? false,
              options?.preserveTimestamps ?? false,
              budget,
            ),
          false,
          false,
          undefined,
          budget,
        );
      });
    },
    copyFile: (fromPath, toPath) => {
      const fromFailure = invalidPath('copyFile', fromPath);
      const toFailure = invalidPath('copyFile', toPath);
      if (fromFailure || toFailure) return Effect.fail(fromFailure ?? toFailure!);
      return Effect.suspend(() => {
        const budget = { remaining: state.readinessTimeout };
        return execute(
          state,
          'copyFile',
          fromPath,
          (_backend, generation) => copyFilePinned(state, generation, fromPath, toPath, budget),
          false,
          false,
          undefined,
          budget,
        );
      });
    },
    open: (path, options) => file(state, path, options?.flag ?? 'r', options?.mode),
    readDirectory: (path, options) => {
      if (options?.recursive !== undefined && typeof options.recursive !== 'boolean')
        return Effect.fail(badArgument('readDirectory', 'recursive must be a boolean'));
      const recursive = options?.recursive ?? false;
      return Effect.suspend(() => {
        const budget = { remaining: state.readinessTimeout };
        return execute(
          state,
          'readDirectory',
          path,
          (_backend, generation) => {
            const readEntries = (directory: string) =>
              execute(
                state,
                'readDirectory',
                directory,
                (backend, current) =>
                  'forGeneration' in backend
                    ? backend.forGeneration(current).readdirEntries(directory)
                    : backend.readdirEntriesSync(directory),
                false,
                false,
                generation,
                budget,
              );
            const result: Array<string> = [];
            const visit = (directory: string, prefix: string): Effect.Effect<void, PlatformError.PlatformError> =>
              Effect.gen(function* () {
                const entries = [...(yield* readEntries(directory))].sort((left, right) =>
                  left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
                );
                for (const entry of entries) {
                  const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
                  result.push(relative);
                  if (recursive && entry.is_dir)
                    yield* visit(
                      directory === '/' ? `/${entry.name}` : `${directory.replace(/\/$/, '')}/${entry.name}`,
                      relative,
                    );
                }
              });
            return Effect.gen(function* () {
              yield* visit(path, '');
              return result;
            });
          },
          false,
          false,
          undefined,
          budget,
        );
      });
    },
    readLink: (path) =>
      execute(state, 'readLink', path, (backend, generation) =>
        'forGeneration' in backend ? backend.forGeneration(generation).readlink(path) : backend.readlinkSync(path),
      ),
    realPath: (path) =>
      execute(state, 'realPath', path, (backend, generation) =>
        'forGeneration' in backend ? backend.forGeneration(generation).realpath(path) : backend.realpathSync(path),
      ),
    remove: (path, options) => {
      if (options?.recursive !== undefined && typeof options.recursive !== 'boolean')
        return Effect.fail(badArgument('remove', 'recursive must be a boolean'));
      if (options?.force !== undefined && typeof options.force !== 'boolean')
        return Effect.fail(badArgument('remove', 'force must be a boolean'));
      const recursive = options?.recursive ?? false;
      const force = options?.force ?? false;
      if (recursive)
        return execute(
          state,
          'remove',
          path,
          (backend, generation) =>
            'forGeneration' in backend ? backend.forGeneration(generation).remove(path) : backend.removeSync(path),
          true,
        ).pipe(
          Effect.catchTag('PlatformError', (error) =>
            force && error.reason._tag === 'NotFound' ? Effect.void : Effect.fail(error),
          ),
        );
      return execute(
        state,
        'remove',
        path,
        (backend, generation) => {
          const lstat = () =>
            'forGeneration' in backend ? backend.forGeneration(generation).lstat(path) : backend.lstatSync(path);
          return Effect.gen(function* () {
            const found = yield* Effect.tryPromise({
              try: () => Promise.resolve(lstat()),
              catch: (error) => error,
            }).pipe(
              Effect.catch((error) => (force && isMissing(error) ? Effect.succeed(undefined) : Effect.fail(error))),
            );
            if (!found) return;
            const removeEntry = () => {
              if (found.is_dir)
                return 'forGeneration' in backend
                  ? backend.forGeneration(generation).rmdir(path)
                  : backend.rmdirSync(path);
              return 'forGeneration' in backend
                ? backend.forGeneration(generation).unlink(path)
                : backend.unlinkSync(path);
            };
            yield* execute(state, 'remove', path, removeEntry, true, false, generation).pipe(
              Effect.catchTag('PlatformError', (error) =>
                force && error.reason._tag === 'NotFound' ? Effect.void : Effect.fail(error),
              ),
            );
          });
        },
        false,
        false,
      );
    },
    rename: (oldPath, newPath) => {
      const oldFailure = invalidPath('rename', oldPath);
      const newFailure = invalidPath('rename', newPath);
      if (oldFailure || newFailure) return Effect.fail(oldFailure ?? newFailure!);
      return execute(
        state,
        'rename',
        oldPath,
        (backend, generation) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).rename(oldPath, newPath)
            : backend.renameSync(oldPath, newPath),
        true,
      );
    },
    stat: (path) =>
      execute(state, 'stat', path, (backend, generation) =>
        'forGeneration' in backend
          ? backend.forGeneration(generation).stat(path).then(fileInfo)
          : fileInfo(backend.statSync(path)),
      ),
    symlink: (fromPath, toPath) => {
      const pathFailure = invalidPath('symlink', toPath);
      if (pathFailure) return Effect.fail(pathFailure);
      if (typeof fromPath !== 'string') return Effect.fail(badArgument('symlink', 'target must be a string'));
      return execute(
        state,
        'symlink',
        toPath,
        (backend, generation) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).symlink(fromPath, toPath)
            : backend.symlinkSync(fromPath, toPath),
        true,
      );
    },
    truncate: (path, length = 0) =>
      !Number.isSafeInteger(length) || length < 0
        ? Effect.fail(badArgument('truncate', 'length must be a non-negative safe integer'))
        : execute(
            state,
            'truncate',
            path,
            (backend, generation) =>
              'forGeneration' in backend
                ? backend.forGeneration(generation).truncate(path, length)
                : backend.truncateSync(path, length),
            true,
          ),
    utimes: (path, atime, mtime) => {
      const atimeMs = validTime(atime);
      const mtimeMs = validTime(mtime);
      if (typeof atimeMs !== 'number') return Effect.fail(atimeMs);
      if (typeof mtimeMs !== 'number') return Effect.fail(mtimeMs);
      return execute(
        state,
        'utimes',
        path,
        (backend, generation) =>
          'forGeneration' in backend
            ? backend.forGeneration(generation).utimes(path, atimeMs, mtimeMs)
            : backend.utimesSync(path, atimeMs, mtimeMs),
        true,
      );
    },
    watch,
  });
  return fs;
};

const layer: Layer.Layer<FileSystem.FileSystem, never, Volume> = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(Volume, make),
);

export const OpfsFileSystem = { make, layer } as const;
