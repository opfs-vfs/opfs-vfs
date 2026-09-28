import { afterEach, expect, it, vi } from 'vitest';
import { getSupport } from '../index_internal';

afterEach(() => vi.unstubAllGlobals());

it('reports supported page prerequisites without constructing or accessing browser resources', () => {
  const request = vi.spyOn(navigator.locks, 'request');
  const getDirectory = vi.spyOn(navigator.storage, 'getDirectory');
  const Worker = globalThis.Worker;
  const SharedArrayBuffer = globalThis.SharedArrayBuffer;
  const BroadcastChannel = globalThis.BroadcastChannel;
  let constructions = 0;
  vi.stubGlobal(
    'Worker',
    new Proxy(Worker, {
      construct(target, args) {
        constructions++;
        return Reflect.construct(target, args);
      },
    }),
  );
  vi.stubGlobal(
    'SharedArrayBuffer',
    new Proxy(SharedArrayBuffer, {
      construct(target, args) {
        constructions++;
        return Reflect.construct(target, args);
      },
    }),
  );
  vi.stubGlobal(
    'BroadcastChannel',
    new Proxy(BroadcastChannel, {
      construct(target, args) {
        constructions++;
        return Reflect.construct(target, args);
      },
    }),
  );
  try {
    expect(getSupport()).toEqual({ supported: true, missing: [] });
    expect(getSupport()).toBe(getSupport());
    expect(Object.isFrozen(getSupport())).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(getDirectory).not.toHaveBeenCalled();
    expect(constructions).toBe(0);
  } finally {
    request.mockRestore();
    getDirectory.mockRestore();
  }
});

it.each([
  ['isSecureContext', 'secure-context'],
  ['crossOriginIsolated', 'cross-origin-isolation'],
  ['SharedArrayBuffer', 'shared-array-buffer'],
  ['Worker', 'worker'],
  ['BroadcastChannel', 'broadcast-channel'],
] as const)('reports a missing %s prerequisite', (name, requirement) => {
  vi.stubGlobal(name, undefined);
  expect(getSupport()).toEqual({ supported: false, missing: [requirement] });
});

it.each([
  ['locks', 'web-locks'],
  ['storage', 'opfs'],
] as const)('reports a missing navigator.%s prerequisite', (property, requirement) => {
  const original = Object.getOwnPropertyDescriptor(navigator, property);
  Object.defineProperty(navigator, property, { value: undefined, configurable: true });
  try {
    expect(getSupport()).toEqual({ supported: false, missing: [requirement] });
  } finally {
    if (original) Object.defineProperty(navigator, property, original);
    else Reflect.deleteProperty(navigator, property);
  }
});

it('does not require the worker-only sync access handle', () => {
  vi.stubGlobal('FileSystemSyncAccessHandle', undefined);
  expect(getSupport()).toEqual({ supported: true, missing: [] });
});
