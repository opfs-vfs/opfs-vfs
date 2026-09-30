import { Deferred, Effect, Semaphore } from 'effect';
import type { Scope } from 'effect';
import type { OpfsVfs } from '@opfs-vfs/opfs-vfs';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import type { VolumeService } from './volume.js';
import type { VolumeError } from './errors.js';

export type Backend = OpfsVfs | OpfsVfsWorkerClient;
export type Continuity =
  | { readonly _tag: 'clean' }
  | { readonly _tag: 'pending'; readonly generation: string }
  | { readonly _tag: 'lost'; readonly generation: string };

export interface Coordinator {
  readonly backend: Backend;
  readonly scope?: Scope.Scope;
  readonly fileName: string;
  readonly isClosed: () => boolean;
  readonly currentGeneration: () => string | undefined;
  readonly canRecapture: () => boolean;
  readonly readinessTimeout: number;
  readonly terminal: () => VolumeError | undefined;
  readonly awaitReady: (budget: { remaining: number }, operation: string) => Effect.Effect<string, VolumeError>;
  readonly gate: Semaphore.Semaphore;
  readonly terminalSignal: Deferred.Deferred<VolumeError>;
  readonly files: Set<() => Effect.Effect<void>>;
  continuity: Continuity;
}

const coordinators = new WeakMap<VolumeService, Coordinator>();

export const makeCoordinator = (
  options: Omit<Coordinator, 'gate' | 'terminalSignal' | 'continuity' | 'files'>,
): Coordinator => ({
  ...options,
  gate: Semaphore.makeUnsafe(1),
  terminalSignal: Deferred.makeUnsafe<VolumeError>(),
  files: new Set(),
  continuity: { _tag: 'clean' },
});

export const registerCoordinator = (service: VolumeService, coordinator: Coordinator): void => {
  coordinators.set(service, coordinator);
};

export const getCoordinator = (service: VolumeService): Coordinator | undefined => coordinators.get(service);

export const latchTerminal = (coordinator: Coordinator, error: VolumeError): void => {
  if (!Deferred.isDoneUnsafe(coordinator.terminalSignal))
    Effect.runSync(Deferred.succeed(coordinator.terminalSignal, error));
};
