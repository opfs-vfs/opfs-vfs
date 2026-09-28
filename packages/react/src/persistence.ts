import { useEffect, useSyncExternalStore } from 'react';

export type PersistentStorageStatus = 'checking' | 'requesting' | 'granted' | 'not-granted' | 'unsupported' | 'error';

export interface PersistentStorageResult {
  readonly status: PersistentStorageStatus;
  readonly error: Error | null;
  request(): Promise<void>;
}

const checking = Object.freeze<PersistentStorageResult>({
  status: 'checking',
  error: null,
  request,
});
let snapshot: PersistentStorageResult = checking;
let pending: Promise<void> | null = null;
let started = false;
let automaticAttempted = false;
let requestAfterCheck = false;
const listeners = new Set<() => void>();

function publish(status: PersistentStorageStatus, error: Error | null = null) {
  if (snapshot.status === status && snapshot.error === error) return;
  snapshot = Object.freeze({ status, error, request });
  for (const listener of [...listeners]) listener();
}

function storage() {
  if (typeof navigator === 'undefined') return null;
  const value = navigator.storage;
  return typeof value?.persisted === 'function' && typeof value.persist === 'function' ? value : null;
}

function run(ask: boolean): Promise<void> {
  if (pending) {
    if (!ask) return pending;
    requestAfterCheck = true;
    return pending;
  }
  let operation!: Promise<void>;
  const settle = (status: PersistentStorageStatus, error: Error | null = null) => {
    if (pending === operation) {
      pending = null;
      requestAfterCheck = false;
    }
    publish(status, error);
  };
  operation = Promise.resolve()
    .then(async () => {
      try {
        const value = storage();
        if (!value) return settle('unsupported');
        if (await value.persisted()) {
          return settle('granted');
        }
        const shouldAsk = ask || requestAfterCheck;
        requestAfterCheck = false;
        if (!shouldAsk) return settle('not-granted');
        publish('requesting');
        const granted = await value.persist();
        settle(granted ? 'granted' : 'not-granted');
      } catch (error) {
        settle('error', error instanceof Error ? error : new Error('Persistent storage request failed'));
      }
    })
    .finally(() => {
      if (pending === operation) {
        pending = null;
        requestAfterCheck = false;
      }
    });
  pending = operation;
  if (snapshot.status !== 'checking') publish('checking');
  return operation;
}

function check() {
  started = true;
  return run(false);
}

export function request(): Promise<void> {
  started = true;
  return run(true);
}

export function requestPersistentStorageOnMount() {
  if (automaticAttempted) return;
  automaticAttempted = true;
  void request();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function usePersistentStorage(): PersistentStorageResult {
  useEffect(() => {
    if (!started) void check();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => checking,
  );
}
