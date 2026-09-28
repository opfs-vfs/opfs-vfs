export type VfsSupportRequirement =
  | 'secure-context'
  | 'cross-origin-isolation'
  | 'shared-array-buffer'
  | 'worker'
  | 'web-locks'
  | 'opfs'
  | 'broadcast-channel';

export interface VfsSupport {
  readonly supported: boolean;
  readonly missing: readonly VfsSupportRequirement[];
}

const supported: VfsSupport = Object.freeze<VfsSupport>({ supported: true, missing: Object.freeze([]) });

/** Detect page-visible prerequisites; detection does not prove a mount will succeed. */
export function getSupport(): VfsSupport {
  const missing: VfsSupportRequirement[] = [];
  if (globalThis.isSecureContext !== true) missing.push('secure-context');
  if (globalThis.crossOriginIsolated !== true) missing.push('cross-origin-isolation');
  if (typeof SharedArrayBuffer !== 'function') missing.push('shared-array-buffer');
  if (typeof Worker !== 'function') missing.push('worker');
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') missing.push('web-locks');
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') missing.push('opfs');
  if (typeof BroadcastChannel !== 'function') missing.push('broadcast-channel');
  return missing.length ? Object.freeze<VfsSupport>({ supported: false, missing: Object.freeze(missing) }) : supported;
}
