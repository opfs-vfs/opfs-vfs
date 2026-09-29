import { Cause, Deferred, Effect, Exit, FileSystem, Layer, PlatformError, Semaphore, Stream } from 'effect';
import { OpenFlags, type OpfsVfs, type VfsStat } from '@opfs-vfs/opfs-vfs';
import { VfsCommandError } from '@opfs-vfs/opfs-vfs/worker';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import { getCoordinator, type Coordinator } from './coordinator.js';
import { Volume } from './volume.js';
import type { VolumeService } from './volume.js';
import { VolumeError, mountError, remoteDetails } from './errors.js';

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
            refusal && remoteDetails(admitted.failure).code === 'VFS_OWNER_READY_TIMEOUT' ? refusal : admitted.failure,
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
                    Deferred.await(state.terminalSignal).pipe(Effect.flatMap(Effect.fail)),
                  ),
                ),
              );
            const terminal = state.terminal();
            const current = state.currentGeneration();
            if (state.isClosed() || terminal)
              return yield* Effect.fail(
                terminal ??
                  new VolumeError({
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
        if (recaptures++ >= 1 || !state.canRecapture() || state.terminal())
          return yield* Effect.fail(platform(localRefusal, method, path, state.fileName, mutate));
        refusal = localRefusal;
        differentGeneration = undefined;
        continue;
      }
      return result.result;
    }
  });
};

const stat = (backend: Backend, generation: string, path: string): Stat | Promise<Stat> =>
  'forGeneration' in backend ? backend.forGeneration(generation).stat(path) : backend.statSync(path);

const unsupportedMethod =
  (method: string, fileName: string) =>
  (...args: ReadonlyArray<unknown>) => {
    const path = typeof args[0] === 'string' ? args[0] : undefined;
    const pathFailure = path === undefined ? undefined : invalidPath(method, path);
    return Effect.fail(pathFailure ?? unsupported(method, path, fileName));
  };

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
      execute(state, 'readFile', path, (backend, generation) => {
        if ('forGeneration' in backend)
          return backend.forGeneration(generation).readFileBuffer(path, maxWholeFileBytes);
        return Effect.scoped(
          Effect.gen(function* () {
            const fd = yield* Effect.acquireRelease(
              Effect.try({
                try: () => backend.openSync(path, OpenFlags.O_RDONLY),
                catch: (error) => mountError(error, state.fileName, 'readFile'),
              }),
              (value) =>
                Effect.try({
                  try: () => backend.closeSync(value),
                  catch: (error) => mountError(error, state.fileName, 'readFile'),
                }).pipe(Effect.orDie),
            );
            const { size } = yield* Effect.try({
              try: () => backend.fstatSync(fd),
              catch: (error) => mountError(error, state.fileName, 'readFile'),
            });
            if (!Number.isSafeInteger(size) || size < 0 || size > maxWholeFileBytes)
              return yield* Effect.fail(
                mountError(
                  Object.assign(new Error('File exceeds the 16 MiB whole-file limit'), { code: 'EFBIG' }),
                  state.fileName,
                  'readFile',
                ),
              );
            const result = yield* Effect.try({
              try: () => backend.readSync(fd, size, 0),
              catch: (error) => mountError(error, state.fileName, 'readFile'),
            });
            return result.buffer.slice(0, result.read);
          }),
        ) as Effect.Effect<Uint8Array, unknown>;
      }),
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
      if (options?.mode !== undefined || bytes.byteLength > maxWholeFileBytes || !['w', 'wx', 'ax'].includes(flag))
        return Effect.fail(unsupported('writeFile', path, state.fileName));
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
    open: unsupportedMethod('open', state.fileName),
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
