import type { VfsPluginFactory } from '@opfs-vfs/opfs-vfs/plugins';
import { subscriptions as configure } from './owner';
import { error } from './validation';

/** Configure bounded file change subscriptions for a direct mount, or register the worker factory. */
export const subscriptions = Object.assign(
  (config: Record<string, never> = {}) => {
    if (!config || typeof config !== 'object' || Array.isArray(config) || Reflect.ownKeys(config).length)
      throw error('EINVAL', 'Subscriptions accept no configuration');
    return configure();
  },
  {
    id: 'subscriptions' as const,
    configure: (input: unknown) => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length)
        throw error('EINVAL', 'Subscriptions accept no configuration');
      return configure();
    },
  },
) satisfies VfsPluginFactory<Record<string, never>>;
