import { expect, it } from 'vitest';
import type { VfsPluginFactory, VfsPluginRegistration, VfsPluginRequest } from '../plugins';
import { testPlugin } from './test-plugin';

it('keeps direct factory options typed while registrations validate unknown inputs', () => {
  function configure(options: unknown) {
    if (!options || typeof options !== 'object' || !('secret' in options) || typeof options.secret !== 'string')
      throw new Error('Expected secret');
    return testPlugin(async ({ data }) => ({ data, destroy() {} }));
  }
  const factory: VfsPluginFactory<{ secret: string }> = Object.assign(configure, { id: 'test-storage', configure });
  const registration: VfsPluginRegistration = factory;
  const request: VfsPluginRequest<{ secret: string }> = {
    id: factory.id,
    contractVersion: 1,
    compatibilityKey: 'test-storage-v1',
    options: { secret: 'test only' },
  };
  expect(factory(request.options).id).toBe(factory.id);
  expect(registration.configure(request.options).id).toBe(factory.id);
  expect(() => registration.configure({ secret: 12 })).toThrow('Expected secret');
  // @ts-expect-error An unknown callable overload must not swallow invalid direct options.
  expect(() => factory({ secret: 12 })).toThrow('Expected secret');
});
