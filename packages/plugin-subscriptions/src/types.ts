import type {
  ChangeType as CoreChangeType,
  FileChange as CoreFileChange,
  TerminalCode,
} from '@opfs-vfs/opfs-vfs/changes';

export type ChangeType = CoreChangeType;
export type FileChange = CoreFileChange;
export type SubscriptionErrorCode = TerminalCode;

export interface SubscriptionError extends Error {
  code: SubscriptionErrorCode;
}

export type SubscriptionRetirement =
  | { readonly status: 'released' }
  | { readonly status: 'unknown'; readonly error: SubscriptionError };

export interface SubscribeOptions {
  path: string;
  scope: 'file' | 'directory';
  recursive?: boolean;
  events?: readonly ChangeType[];
  match?: RegExp;
  content?: false | { maxBytes: number };
  signal?: AbortSignal;
  onError: (error: SubscriptionError) => void;
}

export interface Subscription {
  /** Settles once, never rejects: 'released' after owner release or owner mount close; 'unknown' when confirmation was lost. */
  readonly closed: Promise<SubscriptionRetirement>;
  unsubscribe(): void;
}
