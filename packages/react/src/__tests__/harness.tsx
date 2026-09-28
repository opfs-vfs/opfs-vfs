import { Component, StrictMode, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { VolumeResult } from '../volume';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const volumeName = () => `react-${crypto.randomUUID()}.bin`;
export const worker = () => new Worker(new URL('./volume-worker.ts', import.meta.url), { type: 'module' });
export const bareWorker = () => new Worker(new URL('./bare-worker.ts', import.meta.url), { type: 'module' });

export function countingWorker(factory = worker) {
  const workers: Worker[] = [];
  const create = () => {
    const next = factory();
    workers.push(next);
    return next;
  };
  return {
    create,
    workers,
    get count() {
      return workers.length;
    },
  };
}

export async function waitFor(check: () => boolean | Promise<boolean>, label = 'condition', timeout = 4_000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function bounded<T>(promise: Promise<T>, label: string, timeout = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function mount(node: ReactNode, strict = false) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(strict ? <StrictMode>{node}</StrictMode> : node));
  return {
    root,
    container,
    async render(next: ReactNode) {
      await act(async () => root.render(strict ? <StrictMode>{next}</StrictMode> : next));
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export class ErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

export async function cleanup(
  name: string,
  roots: { unmount(): Promise<void> }[],
  clients: { closeVfs(): Promise<void>; dispose(): void }[],
) {
  // act() scopes must not overlap.
  for (const root of roots) await root.unmount().catch(() => {});
  await Promise.allSettled(clients.map((client) => client.closeVfs()));
  clients.forEach((client) => client.dispose());
  const { deleteVolume } = await import('@opfs-vfs/opfs-vfs');
  await deleteVolume(name).catch(() => {});
}

export async function closeManaged(...results: readonly VolumeResult[][]) {
  const closers = new Set<() => Promise<void>>();
  for (const values of results) for (const value of values) if (value.ownership === 'managed') closers.add(value.close);
  await Promise.allSettled([...closers].map((close) => close()));
}
