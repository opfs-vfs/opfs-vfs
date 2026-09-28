import type { WireSubscribeOptions } from '@opfs-vfs/opfs-vfs/changes';
import type { SubscribeOptions } from './types';

const events = new Set(['create', 'update', 'delete']);
const optionKeys = new Set(['path', 'scope', 'recursive', 'events', 'match', 'content', 'signal', 'onError']);

export function error(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

export type ValidatedOptions = {
  wire: WireSubscribeOptions;
  signal?: AbortSignal;
  onError: SubscribeOptions['onError'];
};

/** Snapshot only data that is safe to send to the owner. */
export function validateOptions(input: SubscribeOptions): ValidatedOptions {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !optionKeys.has(key))
  )
    throw error('EINVAL', 'Invalid subscription options');
  const path = input.path;
  const scope = input.scope;
  const recursive = input.recursive;
  const suppliedEvents = input.events;
  const inputMatch = input.match;
  const content = input.content;
  const signal = input.signal;
  const onError = input.onError;
  if (typeof path !== 'string' || path.includes('\0')) throw error('EINVAL', 'Invalid path');
  if (scope !== 'file' && scope !== 'directory') throw error('EINVAL', 'Invalid scope');
  if (path.endsWith('/') && path !== '/' && scope !== 'directory')
    throw error('EINVAL', 'Trailing slash requires directory scope');
  if (recursive !== undefined && typeof recursive !== 'boolean') throw error('EINVAL', 'Invalid recursive option');
  if (scope === 'file' && recursive) throw error('EINVAL', 'File subscriptions cannot be recursive');
  if (typeof onError !== 'function') throw error('EINVAL', 'onError must be a function');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw error('EINVAL', 'Invalid abort signal');
  let selected = ['create', 'update', 'delete'] as WireSubscribeOptions['events'][number][];
  if (suppliedEvents !== undefined) {
    const supplied = Array.isArray(suppliedEvents) ? Array.from(suppliedEvents) : undefined;
    if (!supplied || supplied.length === 0 || supplied.some((event) => !events.has(event)))
      throw error('EINVAL', 'Invalid events');
    selected = [...new Set(supplied)];
  }
  let match: WireSubscribeOptions['match'];
  if (inputMatch !== undefined) {
    if (!(inputMatch instanceof RegExp)) throw error('EINVAL', 'Invalid match expression');
    match = { source: inputMatch.source, flags: inputMatch.flags };
  }
  if (content !== undefined && content !== false) {
    if (
      !content ||
      typeof content !== 'object' ||
      Array.isArray(content) ||
      Reflect.ownKeys(content).length !== 1 ||
      !Reflect.ownKeys(content).includes('maxBytes')
    )
      throw error('EINVAL', 'Invalid content options');
    const maxBytes = (content as { maxBytes?: unknown }).maxBytes;
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 * 1024)
      throw error('EINVAL', 'Invalid content options');
    return {
      wire: { path, scope, recursive: recursive ?? false, events: selected, match, content: { maxBytes } },
      signal,
      onError,
    };
  }
  return {
    wire: { path, scope, recursive: recursive ?? false, events: selected, match, content: false },
    signal,
    onError,
  };
}

export function normalizePath(path: string): string {
  const pieces: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') pieces.pop();
    else pieces.push(part);
  }
  return `/${pieces.join('/')}`;
}
