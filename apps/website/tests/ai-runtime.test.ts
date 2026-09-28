import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaPipeGemmaRuntime } from '../src/lib/ai/mediapipe-gemma-runtime.ts';

for (const requested of [undefined, 8192, 16384, 32768, 999999]) {
  void test(`reserves output room for configured context ${requested}`, async () => {
    const expected = requested === 16384 || requested === 32768 ? requested : 8192;
    let inputTokens: number | undefined = expected - 2048;
    let generated = 0;
    let capacity = 0;
    const runtime = await createMediaPipeGemmaRuntime({
      contextTokens: requested,
      modelAssetPath: 'test-model',
      wasmRootPath: '/wasm',
      createGpuDevice: async () => ({ destroy() {} }) as GPUDevice,
      mediaPipe: {
        FilesetResolver: { forGenAiTasks: async () => ({}) },
        LlmInference: {
          createFromOptions: async (_fileset, options) => {
            capacity = options.maxTokens;
            return {
              close() {},
              isIdle: true,
              sizeInTokens: () => inputTokens,
              generateResponse: async () => {
                generated++;
                return 'complete response';
              },
            };
          },
        },
      },
    });
    assert.equal(await runtime.generate('website prompt'), 'complete response');
    assert.equal(capacity, expected);
    assert.equal(capacity - inputTokens, 2048);
    for (const tokens of [expected - 2047, undefined, NaN]) {
      inputTokens = tokens;
      await assert.rejects(async () => runtime.generate('too large'), /context|token/i);
    }
    assert.equal(generated, 1);
    runtime.close();
  });
}
