// Adapted from frachter-app/opfs-vfs bash-console at 4d881496, at the owner’s request.
import { formatAiRuntimeError } from './ai-runtime-errors';
import type {
  GemmaRuntimeErrorResponse,
  GemmaRuntimeGenerationChunkResponse,
  GemmaRuntimeWorkerRequest,
  GemmaRuntimeWorkerResponse,
} from './gemma-runtime-protocol';
import type { AiModelId } from './ai-model-catalog';

interface PendingRequest {
  onChunk?: (text: string, done: boolean) => void;
  reject: (error: Error) => void;
  resolve: (value: string | void) => void;
}

interface GemmaRuntimeWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<GemmaRuntimeWorkerResponse>) => void) | null;
  postMessage(message: GemmaRuntimeWorkerRequest): void;
  terminate(): void;
}

interface CreateGemmaRuntimeClientOptions {
  createWorker?: () => GemmaRuntimeWorkerLike;
}

interface GemmaRuntimeInitializeOptions {
  contextTokens?: number;
  modelAssetBuffer?: ReadableStreamDefaultReader<Uint8Array> | Uint8Array;
  modelAssetPath: string;
  modelId: AiModelId;
  wasmRootPath: string;
}

interface GemmaRuntimeGenerateOptions {
  onChunk?: (text: string, done: boolean) => void;
  prompt: string;
  rawPrompt?: string;
}

function defaultCreateWorker() {
  return new Worker('/ai-assets/gemma-runtime.worker.js') as GemmaRuntimeWorkerLike;
}

function toRuntimeError(message: GemmaRuntimeErrorResponse | ErrorEvent) {
  if ('type' in message && message.type === 'ERROR') {
    return new Error(message.error);
  }
  return new Error(formatAiRuntimeError(message) || 'Gemma runtime worker crashed.');
}

export function createGemmaRuntimeClient(options: CreateGemmaRuntimeClientOptions = {}) {
  const createWorker = options.createWorker ?? defaultCreateWorker;
  const pendingRequests = new Map<number, PendingRequest>();
  let worker: GemmaRuntimeWorkerLike | null = null;
  let requestId = 0;

  const resetWorker = () => {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  };

  const failPendingRequests = (error: Error) => {
    for (const pendingRequest of pendingRequests.values()) {
      pendingRequest.reject(error);
    }
    pendingRequests.clear();
  };

  const ensureWorker = () => {
    if (worker) {
      return worker;
    }

    const nextWorker = createWorker();
    nextWorker.onmessage = (event) => {
      const message = event.data;
      if (!message) return;

      const pendingRequest = pendingRequests.get(message.id);
      if (!pendingRequest) return;

      if (message.type === 'GENERATION_CHUNK') {
        const chunkMessage = message as GemmaRuntimeGenerationChunkResponse;
        pendingRequest.onChunk?.(chunkMessage.text, chunkMessage.done);
        return;
      }

      pendingRequests.delete(message.id);

      if (message.type === 'ERROR') {
        pendingRequest.reject(toRuntimeError(message));
        return;
      }

      if (message.type === 'GENERATION_DONE') {
        pendingRequest.resolve(message.output);
        return;
      }

      pendingRequest.resolve();
    };

    nextWorker.onerror = (event) => {
      failPendingRequests(toRuntimeError(event));
      resetWorker();
    };

    worker = nextWorker;
    return nextWorker;
  };

  const postRequest = <T>(message: GemmaRuntimeWorkerRequest, onChunk?: PendingRequest['onChunk']) => {
    const activeWorker = ensureWorker();
    return new Promise<T>((resolve, reject) => {
      pendingRequests.set(message.id, {
        onChunk,
        reject,
        resolve: resolve as PendingRequest['resolve'],
      });
      activeWorker.postMessage(message);
    });
  };

  return {
    dispose() {
      failPendingRequests(new Error('Gemma runtime disposed.'));
      resetWorker();
    },
    generate({ onChunk, prompt }: GemmaRuntimeGenerateOptions) {
      requestId += 1;
      return postRequest<string>(
        {
          id: requestId,
          prompt,
          type: 'GENERATE_RESPONSE',
        },
        onChunk,
      );
    },
    initialize({ modelAssetPath, modelId, wasmRootPath, contextTokens }: GemmaRuntimeInitializeOptions) {
      requestId += 1;
      return postRequest<void>({
        id: requestId,
        modelAssetPath,
        modelId,
        type: 'INITIALIZE_MODEL',
        contextTokens,
        wasmRootPath,
      });
    },
  };
}
