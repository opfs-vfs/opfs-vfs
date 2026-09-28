// Adapted from frachter-app/opfs-vfs bash-console at 4d881496, at the owner’s request.
import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import { normalizeGemmaContextTokens } from './gemma-runtime-protocol.ts';

export interface MediaPipeProgressListener {
  (partialResult: string, done: boolean): void;
}

export interface MediaPipeLlmInferenceLike {
  close(): void;
  generateResponse(prompt: string, progressListener?: MediaPipeProgressListener): Promise<string>;
  isIdle: boolean;
  sizeInTokens(prompt: string): number | undefined;
}

export interface MediaPipeGenAiModule {
  FilesetResolver: {
    isSimdSupported?(): Promise<boolean>;
    forGenAiTasks(basePath?: string): Promise<unknown>;
  };
  LlmInference: {
    createFromOptions(
      wasmFileset: unknown,
      options: MediaPipeGemmaRuntimeConfiguration,
    ): Promise<MediaPipeLlmInferenceLike>;
    createWebGpuDevice?(): Promise<GPUDevice>;
  };
}

export interface MediaPipeGemmaRuntimeConfiguration {
  baseOptions: {
    delegate: 'GPU';
    gpuOptions: {
      device: GPUDevice;
    };
    modelAssetBuffer?: ReadableStreamDefaultReader<Uint8Array> | Uint8Array;
    modelAssetPath?: string;
  };
  maxTokens: number;
  randomSeed: number;
  temperature: number;
  topK: number;
}

export interface CreateMediaPipeGemmaRuntimeOptions {
  contextTokens?: number;
  createGpuDevice?: () => Promise<GPUDevice>;
  mediaPipe?: MediaPipeGenAiModule;
  modelAssetBuffer?: ReadableStreamDefaultReader<Uint8Array> | Uint8Array;
  modelAssetPath?: string;
  wasmRootPath: string;
}

export interface MediaPipeGemmaRuntime {
  close(): void;
  generate(prompt: string, onChunk?: MediaPipeProgressListener): Promise<string>;
}

interface MediaPipeWasmFileset {
  wasmBinaryPath: string;
  wasmLoaderPath: string;
}

const DEFAULT_GEMMA_RUNTIME_CONFIGURATION = {
  randomSeed: 101,
  temperature: 0.7,
  topK: 40,
} as const;

const MIN_WEBGPU_BUFFER_LIMIT = 524_550_144;

const DEFAULT_MEDIA_PIPE: MediaPipeGenAiModule = {
  FilesetResolver,
  LlmInference,
};

async function createConservativeGemmaGpuDevice() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU is unavailable in this browser.');
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new Error('Unable to request a high-performance WebGPU adapter.');
  }

  if (!adapter.features.has('shader-f16')) {
    throw new Error('This WebGPU adapter does not support shader-f16, which Gemma requires.');
  }

  const maxBufferSize = adapter.limits.maxBufferSize;
  const maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;

  if (maxBufferSize < MIN_WEBGPU_BUFFER_LIMIT) {
    console.warn(
      `This WebGPU device is unable to execute most LLM tasks, because the required maxBufferSize is usually at least ${MIN_WEBGPU_BUFFER_LIMIT}, but your device only supports maxBufferSize of ${maxBufferSize}`,
    );
  }

  if (maxStorageBufferBindingSize < MIN_WEBGPU_BUFFER_LIMIT) {
    console.warn(
      `The WebGPU device is unable to execute LLM tasks, because the required maxStorageBufferBindingSize is usually at least ${MIN_WEBGPU_BUFFER_LIMIT}, but your device only supports maxStorageBufferBindingSize of ${maxStorageBufferBindingSize}`,
    );
  }

  return adapter.requestDevice({
    requiredFeatures: ['shader-f16'],
    requiredLimits: {
      maxBufferSize,
      maxStorageBufferBindingSize,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    },
  });
}

async function resolveMediaPipeGenAiWasmFileset(
  mediaPipe: MediaPipeGenAiModule,
  basePath: string,
): Promise<MediaPipeWasmFileset> {
  return (await mediaPipe.FilesetResolver.forGenAiTasks(basePath)) as MediaPipeWasmFileset;
}

export async function createMediaPipeGemmaRuntime(
  options: CreateMediaPipeGemmaRuntimeOptions,
): Promise<MediaPipeGemmaRuntime> {
  if (!options.modelAssetBuffer && !options.modelAssetPath)
    throw new Error('Provide a Gemma model asset before starting the runtime.');
  const mediaPipe = options.mediaPipe ?? DEFAULT_MEDIA_PIPE;
  const maxTokens = normalizeGemmaContextTokens(options.contextTokens);
  const wasmFileset = await resolveMediaPipeGenAiWasmFileset(mediaPipe, options.wasmRootPath);
  const gpuDevice = await (options.createGpuDevice ?? createConservativeGemmaGpuDevice)();
  const baseOptions: MediaPipeGemmaRuntimeConfiguration['baseOptions'] = {
    delegate: 'GPU',
    gpuOptions: {
      device: gpuDevice,
    },
  };

  if (options.modelAssetBuffer) {
    baseOptions.modelAssetBuffer = options.modelAssetBuffer;
  } else if (options.modelAssetPath) {
    baseOptions.modelAssetPath = options.modelAssetPath;
  } else {
    throw new Error('Provide either a Gemma model asset path or a model asset buffer before starting the runtime.');
  }

  let llmInference: MediaPipeLlmInferenceLike;
  try {
    llmInference = await mediaPipe.LlmInference.createFromOptions(wasmFileset, {
      baseOptions,
      ...DEFAULT_GEMMA_RUNTIME_CONFIGURATION,
      maxTokens,
    });
  } catch (error) {
    gpuDevice.destroy();
    throw error;
  }

  return {
    close() {
      try {
        llmInference.close();
      } finally {
        gpuDevice.destroy();
      }
    },
    generate(prompt, onChunk) {
      const inputTokens = llmInference.sizeInTokens(prompt);
      if (inputTokens === undefined || !Number.isFinite(inputTokens))
        throw new Error('Could not measure the model context in tokens.');
      if (inputTokens > maxTokens - 2048)
        throw new Error(
          'The conversation exceeds the local model context. Reload the page to start a new conversation, or use a shorter request. Files already saved are kept.',
        );
      return llmInference.generateResponse(prompt, (partialResult, done) => {
        onChunk?.(partialResult, done);
      });
    },
  };
}
