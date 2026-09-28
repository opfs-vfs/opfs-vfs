export type ChangeType = 'create' | 'update' | 'delete';
export type ChangeKind = 'file' | 'directory' | 'symlink';

export interface FileChange {
  readonly type: ChangeType;
  readonly path: string;
  readonly kind: ChangeKind;
  readonly cursor: { readonly generation: string; readonly sequence: number };
  readonly content:
    | { readonly status: 'included'; readonly bytes: Uint8Array }
    | {
        readonly status: 'omitted';
        readonly reason: 'disabled' | 'deleted' | 'not-file' | 'too-large' | 'unavailable';
      };
}

export interface WireSubscribeOptions {
  readonly path: string;
  readonly scope: 'file' | 'directory';
  readonly recursive: boolean;
  readonly events: readonly ChangeType[];
  readonly match?: { readonly source: string; readonly flags: string };
  readonly content: false | { readonly maxBytes: number };
}

export interface ChangeClient {
  readonly clientId: string;
  readonly channelId: string;
  /** Stamped by core transport; never supplied by subscription controls. */
  readonly route: 'local' | 'follower-relay';
}
export type ChangeCommand =
  | { readonly type: 'register'; readonly subscriptionId: string; readonly options: WireSubscribeOptions }
  | { readonly type: 'activate'; readonly subscriptionId: string }
  | { readonly type: 'ack'; readonly subscriptionId: string; readonly deliveryId: number }
  | { readonly type: 'cancel'; readonly subscriptionId: string }
  | { readonly type: 'terminal-ack'; readonly subscriptionId: string };
export type ChangeReply = { readonly type: 'registered'; readonly subscriptionId: string } | { readonly type: 'ok' };
export type TerminalCode =
  | 'SUBSCRIPTION_OVERFLOW'
  | 'SUBSCRIPTION_INTERRUPTED'
  | 'SUBSCRIPTION_CALLBACK_FAILED'
  | 'SUBSCRIPTION_RESYNC_REQUIRED';
export type ChangeFrame =
  | {
      readonly type: 'event';
      readonly subscriptionId: string;
      readonly deliveryId: number;
      readonly change: FileChange;
    }
  | { readonly type: 'terminal'; readonly subscriptionId: string; readonly code: TerminalCode }
  | { readonly type: 'closed'; readonly subscriptionId: string };
export interface FileChangeChannel {
  readonly generation: string;
  request(command: ChangeCommand): Promise<ChangeReply>;
  close(): void;
}
export interface FileChangeSource {
  openFileChangeChannel(
    receive: (frame: ChangeFrame) => void,
    interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
    closed: () => void,
  ): Promise<FileChangeChannel>;
}

export interface LogicalRecord {
  readonly type: ChangeType;
  readonly path: string;
  readonly kind: ChangeKind;
  readonly cursor: { readonly generation: string; readonly sequence: number };
  readonly inodeId: number;
  readonly size: number;
}
export type CapturedContent =
  /** Borrowed bytes: copy them once per recipient before delivering a change frame. */
  | { readonly status: 'included'; readonly bytes: Uint8Array }
  | { readonly status: 'omitted'; readonly reason: 'deleted' | 'not-file' | 'too-large' | 'unavailable' };
export interface CompletedLogicalOperation {
  readonly records: Iterable<LogicalRecord>;
  /** Returned bytes are borrowed for the duration of `completed`; copy per recipient before `host.send`. */
  capture(record: LogicalRecord, maxBytes: number): CapturedContent;
}
export type ChangeImpact =
  | { readonly kind: 'paths'; readonly paths: readonly { readonly path: string; readonly subtree: boolean }[] }
  | { readonly kind: 'all' };
export interface LogicalChangeHost {
  readonly generation: string;
  validateTarget(target: Pick<WireSubscribeOptions, 'path' | 'scope' | 'recursive'>): void;
  /**
   * Consumes each included delivery buffer. It must be a fresh, isolated full ArrayBuffer view;
   * core rejects capture buffers and previously sent buffers, including aliases of the same capture.
   * After send, the contributor must not read or write the buffer or any alias.
   */
  send(client: ChangeClient, frame: ChangeFrame): void;
}
export interface LogicalChangeSession {
  control(client: ChangeClient, command: ChangeCommand): ChangeReply;
  completed(operation: CompletedLogicalOperation): void;
  invalidated(impact: ChangeImpact, reason: 'partial-mutation' | 'record-limit'): void;
  clientClosed(client: ChangeClient): void;
  close(reason: 'close' | 'initialization-failed' | 'replacement'): void;
}
export interface LogicalChangeContribution {
  readonly version: 1;
  create(host: LogicalChangeHost): LogicalChangeSession;
}
