import { createMediaPipeGemmaRuntime, type MediaPipeGemmaRuntime } from '../lib/ai/mediapipe-gemma-runtime';
import { formatAiRuntimeError } from '../lib/ai/ai-runtime-errors';
import type { GemmaRuntimeWorkerRequest } from '../lib/ai/gemma-runtime-protocol';

let runtime: MediaPipeGemmaRuntime | null = null;

function postRuntimeError(id: number, error: unknown) {
  self.postMessage({
    error: formatAiRuntimeError(error),
    id,
    type: 'ERROR',
  });
}

self.onmessage = async (event: MessageEvent<GemmaRuntimeWorkerRequest>) => {
  const message = event.data;
  if (!message) return;

  if (message.type === 'INITIALIZE_MODEL') {
    try {
      runtime?.close();
      runtime = await createMediaPipeGemmaRuntime({
        modelAssetPath: message.modelAssetPath,
        contextTokens: message.contextTokens,
        wasmRootPath: message.wasmRootPath,
      });
      self.postMessage({
        id: message.id,
        modelId: message.modelId,
        type: 'INITIALIZED',
      });
    } catch (error) {
      postRuntimeError(message.id, error);
    }
    return;
  }

  if (!runtime) {
    postRuntimeError(message.id, new Error('Initialize a Gemma model before generating a response.'));
    return;
  }

  try {
    const output = await runtime.generate(message.prompt, (text, done) => {
      self.postMessage({
        done,
        id: message.id,
        text,
        type: 'GENERATION_CHUNK',
      });
    });
    self.postMessage({
      id: message.id,
      output,
      type: 'GENERATION_DONE',
    });
  } catch (error) {
    postRuntimeError(message.id, error);
  }
};
