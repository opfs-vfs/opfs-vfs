import type { ConfiguredVfsPlugin, VfsPluginFactory, VfsPluginRequest } from '../plugins';
import { VfsCorruptionError } from '../fs-errors';

export interface RegistryTestOptions {
  variant?: 'a' | 'b';
  createOnly?: boolean;
  failMount?: boolean;
  failCorruption?: boolean;
  secret?: string;
  snapshotOnly?: boolean;
  reuse?: boolean;
  failCode?: string;
}

function validate(value: unknown): RegistryTestOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid test plugin options');
  const options = value as Record<string, unknown>;
  if (
    Object.keys(options).some(
      (key) =>
        ![
          'variant',
          'createOnly',
          'failMount',
          'failCorruption',
          'secret',
          'snapshotOnly',
          'reuse',
          'failCode',
        ].includes(key),
    ) ||
    (options.variant !== undefined && options.variant !== 'a' && options.variant !== 'b') ||
    (options.createOnly !== undefined && typeof options.createOnly !== 'boolean') ||
    (options.failMount !== undefined && typeof options.failMount !== 'boolean') ||
    (options.failCorruption !== undefined && typeof options.failCorruption !== 'boolean') ||
    (options.secret !== undefined && typeof options.secret !== 'string') ||
    (options.snapshotOnly !== undefined && typeof options.snapshotOnly !== 'boolean') ||
    (options.reuse !== undefined && typeof options.reuse !== 'boolean') ||
    (options.failCode !== undefined && typeof options.failCode !== 'string')
  ) {
    throw new Error('Invalid test plugin options');
  }
  return options as RegistryTestOptions;
}

export function registryTestRequest(options: RegistryTestOptions = {}): VfsPluginRequest<RegistryTestOptions> {
  const checked = validate(options);
  return {
    id: 'registry-test',
    contractVersion: 1,
    compatibilityKey: `registry-test:${checked.variant ?? 'a'}`,
    ...(checked.createOnly ? { requiredOpenMode: 'create-new' as const } : {}),
    options: { ...checked },
  };
}

let reused: ConfiguredVfsPlugin | undefined;

function configure(options: unknown): ConfiguredVfsPlugin {
  const checked = validate(options);
  if (checked.failCode) {
    const error = new Error('Secret plugin options') as Error & { code?: string };
    if (checked.failCode === 'throw-code-getter') {
      Object.defineProperty(error, 'code', {
        get() {
          throw new Error('Secret code getter');
        },
      });
    } else if (checked.failCode === 'changing-code-getter') {
      let reads = 0;
      Object.defineProperty(error, 'code', {
        get: () => (++reads === 1 ? 'PLUGIN_OPTION_INVALID' : 'invalid'),
      });
    } else {
      error.code = checked.failCode;
    }
    throw error;
  }
  if (checked.reuse && reused) return reused;
  const plugin: ConfiguredVfsPlugin = {
    id: 'registry-test',
    contractVersion: 1,
    compatibilityKey: `registry-test:${checked.variant ?? 'a'}`,
    ...(checked.createOnly ? { requiredOpenMode: 'create-new' as const } : {}),
    storage: {
      sidecars: [],
      factory: async ({ data }) => {
        if (checked.failMount) throw new Error('Test mount failed');
        if (checked.failCorruption) throw new VfsCorruptionError('meta-snapshot', 'Test corruption', 128);
        return { data, destroy() {} };
      },
    },
  };
  if (checked.snapshotOnly) {
    for (const object of [plugin.storage, plugin]) {
      for (const [key, value] of Object.entries(object)) {
        let reads = 0;
        Object.defineProperty(object, key, {
          enumerable: true,
          get() {
            if (++reads > 1) throw new Error(`Plugin field read twice: ${key}`);
            return value;
          },
        });
      }
    }
  }
  if (checked.reuse) reused = plugin;
  return plugin;
}

export const registryTestPlugin = Object.assign((options: RegistryTestOptions) => configure(options), {
  id: 'registry-test' as const,
  configure,
}) satisfies VfsPluginFactory<RegistryTestOptions>;
