/** Private worker-to-mount context; never part of options or a plugin profile. */
export const mountGenerations = new WeakMap<object, string>();
export const workerChangeOpeners = new WeakMap<
  object,
  {
    open(
      clientId: string,
      route: 'local' | 'follower-relay',
      receive: (frame: import('./changes.js').ChangeFrame) => void,
      interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
      closed: () => void,
      channelId: string,
    ): Promise<import('./changes.js').FileChangeChannel>;
  }
>();
export interface PersistenceSource {
  readonly state: import('./opfs-vfs.js').LocalPersistenceState;
  readonly failure: unknown;
  readonly failureRevision: number;
  readonly salvage: import('./opfs-vfs.js').DataWalSalvageEvent | undefined;
}
export const persistenceSources = new WeakMap<
  object,
  { read(): PersistenceSource; watch(listener: () => void): void }
>();
const replacementMounts = new WeakSet<object>();
export const markMountReplacement = (mount: object) => replacementMounts.add(mount);
export const isMountReplacement = (mount: object) => replacementMounts.has(mount);
