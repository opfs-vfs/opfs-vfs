export const workerFactory = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
export const plainWorkerFactory = () => new Worker(new URL('./plain-worker.ts', import.meta.url), { type: 'module' });
