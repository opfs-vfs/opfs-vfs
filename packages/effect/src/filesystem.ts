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
import { Volume } from './volume.js';
import type { VolumeService } from './volume.js';
import { EncryptionError, VolumeError, mountError, remoteDetails } from './errors.js';

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

const execute = <A>(
  state: Coordinator,
  method: string,
  path: string,
  run: (backend: Backend, generation: string) => A | Promise<A> | Effect.Effect<A, unknown>,
  mutate = false,
  recapture = true,
): Effect.Effect<A, PlatformError.PlatformError> => {
  const pathFailure = invalidPath(method, path);
  if (pathFailure) return Effect.fail(pathFailure);
  return Effect.gen(function* () {
    const budget = { remaining: state.readinessTimeout };
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
      if (differentGeneration === generation)
        return yield* Effect.fail(platform(refusal!, method, path, state.fileName, mutate));
      const makeAttempt = () =>
        Effect.scoped(
          Effect.gen(function* () {
            if (mutate)
              yield* Effect.interruptible(
                Effect.asVoid(
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
                ),
              );
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
        const localRefusal = new VfsCommandError(
          Object.assign(new Error('Owner changed before dispatch'), { code: 'VFS_ATTACHMENT_LOST' }),
          'refused',
        );
        if (!recapture || recaptures++ >= 1 || !state.canRecapture() || state.terminal())
          return yield* Effect.fail(platform(localRefusal, method, path, state.fileName, mutate));
        refusal = localRefusal;
        differentGeneration = undefined;
        continue;
      }
      return result.result;
    }
  });
};

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

const openHandle = (state: Coordinator, path: string, flag: FileSystem.OpenFlag, mode?: number) => {
  if (!Object.hasOwn(openFlags, flag)) return Effect.fail(badArgument('open', 'unsupported file flag'));
  if (mode !== undefined && !validMode(mode))
    return Effect.fail(badArgument('open', 'mode must be an unsigned 32-bit integer'));
  const flags = openFlags[flag];
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
          catch: (error) => mountError(error, state.fileName, 'close'),
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
): Effect.Effect<FileSystem.File, PlatformError.PlatformError, import('effect').Scope.Scope> =>
  Effect.flatMap(openHandle(state, path, flag, mode), (handle) =>
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
                    const chunk = Uint8Array.from(bytes.subarray(written));
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

const partialWriteFailure = (state: Coordinator, path: string, error: unknown) => {
  const original = PlatformError.isPlatformError(error) ? error.reason.cause : undefined;
  const cause = Schema.is(VolumeError)(original)
    ? new VolumeError({
        kind: original.kind,
        fileName: original.fileName,
        operation: 'writeAll',
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
          operation: 'writeAll',
          path,
          ...(original.code === undefined ? {} : { code: original.code }),
          outcome: 'possibly-applied',
          details: original.details,
          ...(original.cause === undefined ? {} : { cause: original.cause }),
        })
      : new VolumeError({
          kind: 'filesystem',
          fileName: state.fileName,
          operation: 'writeAll',
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
    method: 'writeAll',
    pathOrDescriptor: path,
    ...(details.message ? { description: details.message } : {}),
    cause,
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
                catch: (error) => mountError(error, state.fileName, 'readFile'),
              })
            : Effect.try({
                try: () => backend.closeSync(value),
                catch: (error) => mountError(error, state.fileName, 'readFile'),
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

const unsupportedMethod =
  (method: string, fileName: string) =>
  (...args: ReadonlyArray<unknown>) => {
    const path = typeof args[0] === 'string' ? args[0] : undefined;
    const pathFailure = path === undefined ? undefined : invalidPath(method, path);
    return Effect.fail(pathFailure ?? unsupported(method, path, fileName));
  };

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
  if (!Number.isSafeInteger(value.mode) || !Number.isSafeInteger(value.size) || value.size < 0)
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
  const fs = FileSystem.make({
    access: (path, options) =>
      execute(state, 'access', path, async (backend, generation) => {
        const info = await stat(backend, generation, path);
        const read = (info.mode & 0o444) !== 0;
        const write = (info.mode & 0o222) !== 0;
        if ((options?.readable && !read) || (options?.writable && !write))
          throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      }),
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
    copy: unsupportedMethod('copy', state.fileName),
    copyFile: unsupportedMethod('copyFile', state.fileName),
    chmod: unsupportedMethod('chmod', state.fileName),
    chown: unsupportedMethod('chown', state.fileName),
    glob: () => Effect.fail(unsupported('glob', undefined, state.fileName)),
    link: unsupportedMethod('link', state.fileName),
    makeDirectory: unsupportedMethod('makeDirectory', state.fileName),
    makeTempDirectory: unsupportedMethod('makeTempDirectory', state.fileName),
    makeTempDirectoryScoped: unsupportedMethod('makeTempDirectoryScoped', state.fileName),
    makeTempFile: unsupportedMethod('makeTempFile', state.fileName),
    makeTempFileScoped: unsupportedMethod('makeTempFileScoped', state.fileName),
    open: (path, options) => file(state, path, options?.flag ?? 'r', options?.mode),
    readDirectory: unsupportedMethod('readDirectory', state.fileName),
    readLink: unsupportedMethod('readLink', state.fileName),
    realPath: unsupportedMethod('realPath', state.fileName),
    remove: unsupportedMethod('remove', state.fileName),
    rename: unsupportedMethod('rename', state.fileName),
    stat: unsupportedMethod('stat', state.fileName),
    symlink: unsupportedMethod('symlink', state.fileName),
    truncate: unsupportedMethod('truncate', state.fileName),
    utimes: unsupportedMethod('utimes', state.fileName),
    watch: () => Stream.fail(unsupported('watch', undefined, state.fileName)),
  });
  return fs;
};

const layer: Layer.Layer<FileSystem.FileSystem, never, Volume> = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(Volume, make),
);

export const OpfsFileSystem = { make, layer } as const;
