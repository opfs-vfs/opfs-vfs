export const phases = ['create', 'write', 'read', 'rename', 'delete', 'flush', 'reopen'] as const;
export type FilesystemConfig = {
  files: number;
  repetitions: number;
  bufferMode: 'memory' | 'disk';
  durability: 'relaxed' | 'balanced' | 'strict';
};
export type FilesystemSample = {
  repetition: number;
  mountMs: number;
  timings: Partial<Record<(typeof phases)[number], number>>;
  status: 'ok' | 'failed' | 'cancelled';
  verifiedFiles: number;
  error?: string;
};
export type FilesystemEvent = { type: 'sample'; sample: FilesystemSample } | { type: 'done' };
export function validateFilesystemConfig(config: FilesystemConfig) {
  if (
    ![100, 1000].includes(config.files) ||
    ![1, 3, 5].includes(config.repetitions) ||
    !['memory', 'disk'].includes(config.bufferMode) ||
    !['relaxed', 'balanced', 'strict'].includes(config.durability)
  )
    throw new Error('Unsupported filesystem benchmark settings.');
}
