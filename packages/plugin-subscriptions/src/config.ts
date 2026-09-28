import type { VfsPluginRequest } from '@opfs-vfs/opfs-vfs/plugins';
import { error } from './validation';

export const SUBSCRIPTIONS_COMPATIBILITY_KEY = 'subscriptions-v1';

export function subscriptionsRequest(options: Record<string, never> = {}): VfsPluginRequest<Record<string, never>> {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Reflect.ownKeys(options).length)
    throw error('EINVAL', 'Subscriptions accept no configuration');
  return { id: 'subscriptions', contractVersion: 1, compatibilityKey: SUBSCRIPTIONS_COMPATIBILITY_KEY, options: {} };
}
