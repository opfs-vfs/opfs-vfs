import { Context, Effect, Layer, Scope, Stream } from 'effect';
import type { FileChange } from '@opfs-vfs/plugin-subscriptions/client';
import type { SubscribeOptions as PluginSubscribeOptions } from '@opfs-vfs/plugin-subscriptions/client';
import { makeSubscriptionInternal } from './subscriptions-internal.js';
import { getCoordinator } from './coordinator.js';
import { VolumeError, SubscriptionError } from './errors.js';
import { Volume } from './volume.js';

export type SubscribeOptions = Omit<PluginSubscribeOptions, 'onError' | 'signal'>;
export type SubscriptionRetirement =
  | { readonly status: 'released' }
  | { readonly status: 'unknown'; readonly error: SubscriptionError };

export interface Subscription {
  readonly changes: Stream.Stream<FileChange, SubscriptionError>;
  readonly retired: Effect.Effect<SubscriptionRetirement>;
}

export interface SubscriptionsService {
  readonly subscribe: (options: SubscribeOptions) => Effect.Effect<Subscription, SubscriptionError, Scope.Scope>;
}

export class Subscriptions extends Context.Service<Subscriptions, SubscriptionsService>()(
  '@opfs-vfs/effect/Subscriptions',
) {}

export const layer: Layer.Layer<Subscriptions, VolumeError, Volume> = Layer.effect(
  Subscriptions,
  Effect.gen(function* () {
    const volume = yield* Volume;
    const state = getCoordinator(volume);
    if (!state || !state.subscriptionsAvailable)
      return yield* Effect.fail(
        new VolumeError({
          kind: 'unsupported',
          fileName: state?.fileName ?? volume.fileName,
          operation: 'subscribe',
          code: 'ENOTSUP',
          outcome: 'not-applied',
          details: null,
        }),
      );
    return { subscribe: (options) => makeSubscriptionInternal(state, options) };
  }),
);
