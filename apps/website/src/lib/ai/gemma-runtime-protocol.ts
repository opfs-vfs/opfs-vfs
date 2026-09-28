// Adapted from frachter-app/opfs-vfs bash-console at 4d881496, at the owner’s request.
import type { AiModelId } from './ai-model-catalog';

export function normalizeGemmaContextTokens(value: unknown): number {
  return value === 16384 || value === 32768 ? value : 8192;
}

export interface GemmaRuntimeInitializeRequest {
  contextTokens?: number;
  id: number;
  modelAssetPath: string;
  modelId: AiModelId;
  type: 'INITIALIZE_MODEL';
  wasmRootPath: string;
}

export interface GemmaRuntimeGenerateRequest {
  id: number;
  prompt: string;
  type: 'GENERATE_RESPONSE';
}

export type GemmaRuntimeWorkerRequest = GemmaRuntimeInitializeRequest | GemmaRuntimeGenerateRequest;

export interface GemmaRuntimeInitializedResponse {
  id: number;
  modelId: AiModelId;
  type: 'INITIALIZED';
}

export interface GemmaRuntimeGenerationChunkResponse {
  done: boolean;
  id: number;
  text: string;
  type: 'GENERATION_CHUNK';
}

export interface GemmaRuntimeGenerationDoneResponse {
  id: number;
  output: string;
  type: 'GENERATION_DONE';
}

export interface GemmaRuntimeErrorResponse {
  error: string;
  id: number;
  type: 'ERROR';
}

export type GemmaRuntimeWorkerResponse =
  | GemmaRuntimeInitializedResponse
  | GemmaRuntimeGenerationChunkResponse
  | GemmaRuntimeGenerationDoneResponse
  | GemmaRuntimeErrorResponse;
