import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VOLUME, type VolumeResult, VolumeError, VolumeProvider, useVolume } from '../index';
import { closeManaged, ErrorBoundary, mount, volumeName, waitFor, worker } from './harness';

function Read({
  name,
  seen,
  results,
}: {
  name?: string | typeof DEFAULT_VOLUME;
  seen: string[];
  results?: VolumeResult[];
}) {
  const volume = useVolume(name);
  results?.push(volume);
  seen.push(`${typeof name === 'symbol' ? 'symbol' : (name ?? 'omitted')}:${volume.generation}`);
  return null;
}

function Capture({ name, into }: { name?: string | typeof DEFAULT_VOLUME; into: { value?: VolumeResult } }) {
  into.value = useVolume(name);
  return null;
}

describe('volume lookup', () => {
  it('uses the nearest unnamed provider for omitted and DEFAULT_VOLUME selectors', async () => {
    const fileName = volumeName();
    const assets = volumeName();
    const results: VolumeResult[] = [];
    const outer: { value?: VolumeResult } = {};
    const named: { value?: VolumeResult } = {};
    const omitted: { value?: VolumeResult } = {};
    const symbol: { value?: VolumeResult } = {};
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={worker}>
        {(v) => {
          results.push(v);
          outer.value = v;
          return (
            <VolumeProvider name="assets" fileName={assets} worker={worker}>
              {(a) => {
                results.push(a);
                named.value = a;
                return (
                  <>
                    <Capture into={omitted} />
                    <Capture name={DEFAULT_VOLUME} into={symbol} />
                  </>
                );
              }}
            </VolumeProvider>
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(
        () =>
          outer.value?.status === 'ready' &&
          named.value?.status === 'ready' &&
          omitted.value?.status === 'ready' &&
          symbol.value?.status === 'ready',
      );
      expect(outer.value?.generation).not.toBe(named.value?.generation);
      expect(omitted.value?.generation).toBe(outer.value?.generation);
      expect(symbol.value?.generation).toBe(outer.value?.generation);
    } finally {
      await closeManaged(results);
      await app.unmount();
      await Promise.all([fileName, assets].map((name) => deleteVolume(name).catch(() => {})));
    }
  });

  it('selects an outer string key through an inner provider with another key', async () => {
    const outerName = volumeName();
    const innerName = volumeName();
    const results: VolumeResult[] = [];
    const outer: { value?: VolumeResult } = {};
    const inner: { value?: VolumeResult } = {};
    const selectOuter: { value?: VolumeResult } = {};
    const selectInner: { value?: VolumeResult } = {};
    const app = await mount(
      <VolumeProvider name="a" fileName={outerName} worker={worker}>
        {(a) => {
          results.push(a);
          outer.value = a;
          return (
            <VolumeProvider name="b" fileName={innerName} worker={worker}>
              {(b) => {
                results.push(b);
                inner.value = b;
                return (
                  <>
                    <Capture name="a" into={selectOuter} />
                    <Capture name="b" into={selectInner} />
                  </>
                );
              }}
            </VolumeProvider>
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => selectOuter.value?.status === 'ready' && selectInner.value?.status === 'ready');
      expect(outer.value?.generation).not.toBe(inner.value?.generation);
      expect(selectOuter.value?.generation).toBe(outer.value?.generation);
      expect(selectInner.value?.generation).toBe(inner.value?.generation);
    } finally {
      await closeManaged(results);
      await app.unmount();
      await Promise.all([outerName, innerName].map((name) => deleteVolume(name).catch(() => {})));
    }
  });

  it('keeps the string default separate from the default symbol and shadows same keys', async () => {
    const outer = volumeName();
    const named = volumeName();
    const inner = volumeName();
    const results: VolumeResult[] = [];
    const outerDefault: { value?: VolumeResult } = {};
    const innerDefault: { value?: VolumeResult } = {};
    const namedOuter: { value?: VolumeResult } = {};
    const namedInner: { value?: VolumeResult } = {};
    const stringDefault: { value?: VolumeResult } = {};
    const namedProvider: { value?: VolumeResult } = {};
    const innerProvider: { value?: VolumeResult } = {};
    const app = await mount(
      <VolumeProvider fileName={outer} worker={worker}>
        {(v) => {
          results.push(v);
          return (
            <>
              <Capture into={outerDefault} />
              <VolumeProvider name="default" fileName={named} worker={worker}>
                {(namedResult) => {
                  results.push(namedResult);
                  namedProvider.value = namedResult;
                  return (
                    <>
                      <Capture into={innerDefault} />
                      <Capture name="default" into={namedOuter} />
                      <VolumeProvider name="default" fileName={inner} worker={worker}>
                        {(innerResult) => {
                          results.push(innerResult);
                          innerProvider.value = innerResult;
                          return (
                            <>
                              <Capture name="default" into={namedInner} />
                              <Capture name={'default'} into={stringDefault} />
                            </>
                          );
                        }}
                      </VolumeProvider>
                    </>
                  );
                }}
              </VolumeProvider>
            </>
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(
        () =>
          outerDefault.value?.status === 'ready' &&
          innerDefault.value?.status === 'ready' &&
          namedOuter.value?.status === 'ready' &&
          namedInner.value?.status === 'ready' &&
          stringDefault.value?.status === 'ready',
      );
      expect(outerDefault.value?.generation).not.toBe(namedOuter.value?.generation);
      expect(namedOuter.value?.generation).not.toBe(namedInner.value?.generation);
      expect(outerDefault.value?.generation).toBe(innerDefault.value?.generation);
      expect(namedOuter.value?.generation).toBe(namedProvider.value?.generation);
      expect(namedInner.value?.generation).toBe(innerProvider.value?.generation);
      expect(namedInner.value?.generation).toBe(stringDefault.value?.generation);
    } finally {
      await closeManaged(results);
      await app.unmount();
      await Promise.all([outer, named, inner].map((name) => deleteVolume(name).catch(() => {})));
    }
  });

  it('reports invalid, empty, missing, and sibling-only lookup keys during render', async () => {
    const fileName = volumeName();
    const errors: Error[] = [];
    const app = await mount(
      <ErrorBoundary onError={(error) => errors.push(error)}>
        <VolumeProvider fileName={fileName} worker={worker}>
          <Read name={Symbol('opfs-vfs.default-volume') as never} seen={[]} />
        </VolumeProvider>
      </ErrorBoundary>,
    );
    try {
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toBeInstanceOf(VolumeError);
      expect(errors[0]).toMatchObject({ kind: 'configuration', operation: 'lookup' });
    } finally {
      await app.unmount();
      await deleteVolume(fileName).catch(() => {});
    }
    for (const name of ['' as const, 'missing' as const, Symbol('other') as never]) {
      const caught: Error[] = [];
      const next = await mount(
        <ErrorBoundary onError={(error) => caught.push(error)}>
          <Read name={name} seen={[]} />
        </ErrorBoundary>,
      );
      await waitFor(() => caught.length === 1);
      expect(caught[0]).toMatchObject({ kind: 'configuration', operation: 'lookup' });
      await next.unmount();
    }
  });

  it('does not reopen when only the alias changes, but separates physical volumes', async () => {
    const fileName = volumeName();
    const other = volumeName();
    let factories = 0;
    const factory = () => {
      factories++;
      return worker();
    };
    const seen: ReturnType<typeof useVolume>[] = [];
    const render = (name?: string, current = fileName) => (
      <VolumeProvider name={name} fileName={current} worker={factory}>
        {(result) => {
          seen.push(result);
          return null;
        }}
      </VolumeProvider>
    );
    const app = await mount(render());
    try {
      await waitFor(() => seen.at(-1)?.status === 'ready');
      const generation = seen.at(-1)?.generation;
      await app.render(render('assets'));
      await waitFor(() => seen.at(-1)?.generation === generation);
      expect(factories).toBe(1);
      const second = await mount(render(undefined, other));
      await waitFor(() => seen.some((result) => result.status === 'ready' && result.generation !== generation));
      await second.unmount();
    } finally {
      await closeManaged(seen);
      await app.unmount();
      await Promise.all([fileName, other].map((name) => deleteVolume(name).catch(() => {})));
    }
  });
});
