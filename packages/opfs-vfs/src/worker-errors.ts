interface WorkerErrorLogContext {
  code?: string;
  message?: string;
  payload?: unknown;
  type?: string;
}

export function shouldLogWorkerError(context: WorkerErrorLogContext) {
  return context.code !== 'ENOENT' && context.code !== 'ENOTDIR';
}
