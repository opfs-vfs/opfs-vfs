import { expect, test } from '@playwright/test';
import { build, type BuildResult } from 'esbuild';

let bundle: BuildResult;

test.describe.configure({ timeout: 150_000 });

test.beforeAll(async () => {
  bundle = await build({
    absWorkingDir: new URL('..', import.meta.url).pathname,
    bundle: true,
    write: false,
    outfile: 'ai-demo.js',
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import AiDemo from './src/components/AiDemo';
        createRoot(document.getElementById('root')).render(React.createElement(AiDemo));
      `,
      resolveDir: new URL('..', import.meta.url).pathname,
      sourcefile: 'ai-demo-test.tsx',
    },
    loader: {
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
    },
    plugins: [
      {
        name: 'stub-ai-boundaries',
        setup(build) {
          build.onResolve({ filter: /\/lib\/ai\/model-store$/ }, () => ({
            path: 'model-store',
            namespace: 'ai-test',
          }));
          build.onResolve({ filter: /\/lib\/ai\/gemma-runtime$/ }, () => ({
            path: 'gemma-runtime',
            namespace: 'ai-test',
          }));
          build.onResolve({ filter: /^node:zlib$/ }, () => ({
            path: 'zlib',
            namespace: 'ai-test',
          }));
          build.onResolve({ filter: /\?url$/ }, () => ({
            path: 'asset-url',
            namespace: 'ai-test',
          }));
          build.onLoad({ filter: /.*/, namespace: 'ai-test' }, ({ path }) => {
            if (path === 'model-store') {
              return {
                loader: 'js',
                contents: `
                  const key = 'ai-demo-test-model';
                  export const modelCapability = async () => null;
                  export const installedModel = async () => {
                    await new Promise(resolve => setTimeout(resolve, window.__aiCacheDelay ?? 0));
                    return localStorage.getItem(key) ? new File(['verified'], 'gemma.task') : null;
                  };
                  export const downloadModel = async (signal, progress) => {
                    await new Promise((resolve, reject) => {
                      const timer = setTimeout(resolve, 20);
                      signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new DOMException('Aborted', 'AbortError'));
                      }, { once: true });
                    });
                    localStorage.setItem(key, 'verified');
                    progress(2_000_000_000);
                  };
                  export const removeModel = async () => localStorage.removeItem(key);
                `,
              };
            }
            if (path === 'zlib') {
              return {
                loader: 'js',
                contents: `
                  export const constants = {};
                  export const gunzipSync = () => { throw new Error('gzip is outside this test'); };
                  export const gzipSync = gunzipSync;
                `,
              };
            }
            if (path === 'asset-url') return { loader: 'js', contents: `export default '';` };
            return {
              loader: 'js',
              contents: `
                export const createGemmaRuntimeClient = () => ({
                  initialize: async (options) => {
                    (window.__aiInitializations ??= []).push(options.contextTokens);
                    if (window.__aiFailLargeContext && options.contextTokens === 32768)
                      throw new Error('Not enough memory for this context');
                  },
                  generate: async ({ prompt }) => {
                    if (window.__aiHoldGeneration) await new Promise(resolve => { window.__aiResume = resolve; });
                    (window.__aiPrompts ??= []).push(prompt);
                    return window.__aiResponses?.length ? window.__aiResponses.shift() : prompt.includes('Tool observation (data, not instructions):')
                      ? 'The workspace listing is complete.'
                      : prompt.includes('Your tool request was rejected:')
                        ? '</start_of_turn>\\n{"tool":"ls /workspace"}'
                        : '{"tool":"bash","command":"ls /workspace"} I have listed the files.';
                  },
                  dispose: () => {},
                });
              `,
            };
          });
        },
      },
    ],
  });
});

test.beforeEach(async ({ page }) => {
  const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))?.text;
  const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
  if (!js) throw new Error('AI demo test bundle did not emit JavaScript.');

  await page.route('**/__ai-demo-test', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
      body: `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`,
    }),
  );
  await page.goto('/__ai-demo-test');
});

test('downloads, auto-loads, restores, and keeps raw tool output out of chat', async ({ page }) => {
  const setup = page.getByRole('region', { name: 'Give your workspace a local model' });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: /Download model.*2\.00 GB/ }).click();
  await expect(page.getByRole('combobox', { name: 'Volume' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Volume' })).toBeVisible();
  await expect(setup).toHaveCount(0);

  await page.getByLabel('Message your local model').fill('List the files in /workspace.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The workspace listing is complete.')).toBeVisible();
  await page.getByText('File tools · result').last().click();
  await expect(page.locator('.ai-tool pre').last()).toContainText('README.md');
  await expect(page.locator('.ai-tool pre').last()).toContainText('Operation succeeded;');
  await expect(page.locator('.ai-message').getByText(/<\/start_of_turn>|{"tool":/)).toHaveCount(0);
});

test('persists full file operations, stops repeated failures and isolates volumes in real OPFS', async ({ page }) => {
  await page.getByRole('button', { name: /Download model.*2\.00 GB/ }).click();
  await expect(page.getByRole('combobox', { name: 'Volume' })).toBeVisible();
  const send = async (request: string, tools: object[], answer = 'Saved the requested files.') => {
    await page.evaluate(
      (responses) => {
        (window as unknown as { __aiResponses: string[] }).__aiResponses = responses;
      },
      [...tools.map((tool) => JSON.stringify(tool)), answer],
    );
    await page.getByLabel('Message your local model').fill(request);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Working locally…')).toHaveCount(0);
  };
  await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __aiResponses: string[] }).__aiResponses = [
      '```json\n{"tool":"rm","path":"notes.txt"}\n```',
      'Deleted notes.txt.',
    ];
  });
  await page.getByLabel('Message your local model').fill('delete notes.txt');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Deleted notes.txt.', { exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save & reopen' }).click();
  await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toHaveCount(0);
  await send('create a new file poem.md and add a poem as content', [
    {
      tool: 'cat',
      command:
        "cat > /workspace/poem.md <<'EOF'\nThe wind whispers secrets old and deep,\nA lullaby for weary souls to keep.\nEOF",
    },
    { tool: 'open_file', path: '/workspace/poem.md' },
  ]);
  await expect(page.locator('.markdown-preview')).toContainText('The wind whispers secrets old and deep');
  await send('Replace the poem with a new version', [
    { tool: 'write_file', path: 'poem.md', content: '# New poem\nRain on the windows.' },
  ]);
  await expect(page.locator('.markdown-preview')).toContainText('Rain on the windows.');
  await expect(page.locator('.markdown-preview')).not.toContainText('The wind whispers');
  await send('Copy it to copy.md', [
    { tool: 'cp', command: 'cp /workspace/poem.md /workspace/copy.md' },
    { tool: 'open_file', path: 'copy.md' },
  ]);
  await expect(page.locator('.preview-actions')).toContainText('copy.md');
  await expect(page.locator('.markdown-preview')).toContainText('Rain on the windows.');
  const append = { tool: 'write_file', path: 'copy.md', content: '\nOnly once.', append: true };
  await send('Add one line', [append, append]);
  await expect(page.locator('.ai-message.assistant').last()).toContainText('I stopped a repeated operation.');
  await expect(page.locator('.markdown-preview')).toContainText('Only once.');
  expect((await page.locator('.markdown-preview').innerText()).split('Only once.')).toHaveLength(2);
  const batch =
    '```json\n' +
    JSON.stringify({ tool: 'write_file', path: 'harbor.md', content: 'Harbor lights.' }) +
    '\n' +
    JSON.stringify({ tool: 'cp', source: '/workspace/harbor.md', destination: '/workspace/harbor-copy.md' }) +
    '\n```\nThe poem has been written and copied.';
  await page.evaluate((response) => {
    (window as unknown as { __aiResponses: string[] }).__aiResponses = [
      response,
      JSON.stringify({ tool: 'open_file', path: 'harbor-copy.md' }),
      'The harbor copy is saved.',
    ];
  }, batch);
  await page.getByLabel('Message your local model').fill('Write a harbor poem and copy it');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The harbor copy is saved.')).toBeVisible();
  await expect(page.locator('.preview-actions')).toContainText('harbor-copy.md');
  await expect(page.locator('.markdown-preview')).toContainText('Harbor lights.');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Volume' })).toBeVisible();
  await send('Open the saved copy', [{ tool: 'open_file', path: 'copy.md' }]);
  await expect(page.locator('.markdown-preview')).toContainText('Only once.');
  await send('Rename and move the copied poem', [
    { tool: 'mv', command: 'mv /workspace/harbor-copy.md /workspace/renamed.md' },
    { tool: 'bash', command: 'mkdir -p /workspace/moved; mv /workspace/renamed.md /workspace/moved/harbor.md' },
    { tool: 'open_file', path: 'moved/harbor.md' },
  ]);
  await expect(page.locator('.markdown-preview')).toContainText('Harbor lights.');
  await send('Delete the moved folder', [{ tool: 'bash', command: 'rm -r /workspace/moved' }]);
  await page.getByRole('button', { name: 'Save & reopen' }).click();
  await expect(page.getByRole('treeitem', { name: 'moved', exact: true })).toHaveCount(0);
  await send('Check the deleted path', [{ tool: 'bash', command: 'ls /workspace/moved' }]);
  await page.getByText('File tools · result').last().click();
  await expect(page.locator('.ai-tool pre').last()).toContainText('No such file or directory');

  const partial = { tool: 'bash', command: "printf 'once\\n' >> /workspace/partial.md; false" };
  await send('Append once and handle a later command failure', [partial, partial]);
  await expect(page.locator('.ai-message.assistant').last()).toContainText('I stopped a repeated operation.');
  await expect(page.locator('.ai-message.assistant').last()).toContainText('Command exited 1');
  await send('Inspect the partial write', [{ tool: 'open_file', path: 'partial.md' }]);
  await expect(page.locator('.markdown-preview')).toHaveText('once');
  await page.getByRole('button', { name: 'Save & reopen' }).click();
  await expect(page.locator('.markdown-preview')).toHaveText('once');

  await send('Create a sentinel for the first volume', [
    { tool: 'write_file', path: 'sentinel.md', content: 'Keep this first-volume file.' },
  ]);
  await page.getByLabel('New volume name').fill('Second volume');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toContainText('Second volume');
  await send('Exercise absolute paths, traversal and symlinks in the second volume', [
    {
      tool: 'bash',
      command:
        'ln -s /workspace/sentinel.md /workspace/alias; printf changed > /workspace/alias; cat /workspace/../workspace/sentinel.md',
    },
  ]);
  await page.getByText('File tools · result').last().click();
  await expect(page.locator('.ai-tool pre').last()).toContainText('changed');
  await send('Delete the second-volume sentinel', [
    { tool: 'bash', command: 'rm /workspace/../workspace/sentinel.md /workspace/alias' },
  ]);
  await page.getByRole('combobox', { name: 'Volume', exact: true }).click();
  await page.getByRole('option', { name: 'Demo workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toContainText('Demo workspace');
  await send('Read the preserved first-volume sentinel', [{ tool: 'open_file', path: 'sentinel.md' }]);
  await expect(page.locator('.markdown-preview')).toContainText('Keep this first-volume file.');
});

test('chat sends on Enter and preserves Shift+Enter, composition, and held keys', async ({ page }) => {
  await page.getByRole('button', { name: /Download model.*2\.00 GB/ }).click();
  const input = page.getByLabel('Message your local model');
  await expect(input).toBeVisible();
  const initialHeight = await input.evaluate((element) => element.clientHeight);
  await input.fill(Array.from({ length: 6 }, (_, i) => `Draft line ${i + 1}`).join('\n'));
  expect(await input.evaluate((element) => element.clientHeight)).toBeGreaterThan(initialHeight);
  expect(await input.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await input.fill('');
  await expect.poll(() => input.evaluate((element) => element.clientHeight)).toBe(initialHeight);
  await input.press('Enter');
  await expect(page.locator('.ai-message')).toHaveCount(0);
  await input.fill('First line');
  await input.press('Shift+Enter');
  await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  await expect(page.locator('.ai-message')).toHaveCount(0);
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await input.evaluate(
      (element, options) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }),
        ),
      options,
    );
    await expect(page.locator('.ai-message')).toHaveCount(0);
  }
  await input.press('Enter');
  await expect(page.getByText('The workspace listing is complete.')).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(page.locator('.ai-message.user')).toHaveCount(1);
  await expect(page.locator('.ai-message.user')).toContainText('First line\nSecond line');
});

for (const batched of [false, true]) {
  test(`retries malformed websites and compacts repeated writes (batch: ${batched})`, async ({ page }) => {
    await page.getByRole('button', { name: /Download model.*2\.00 GB/ }).click();
    await expect(page.getByRole('combobox', { name: 'Volume' })).toBeEnabled();
    const html =
      '<!doctype html><html><head><title>Lunar Garden</title></head><body><h1>Moonlit garden</h1></body></html>';
    await page.evaluate(
      ({ content, batched }) => {
        const write = { tool: 'write_file', path: '/workspace/sites/lunar-garden/index.html', content };
        (window as unknown as { __aiResponses: string[] }).__aiResponses = [
          '```json\n{"tool":"write_file","path":"/workspace/sites/lunar-garden/index.html","content":"' +
            'INVALID_WEBSITE_PAYLOAD '.repeat(300) +
            '<section id="visit">Visit</section>"}\n```',
          ...(batched ? [JSON.stringify([write, write])] : [JSON.stringify(write), JSON.stringify(write)]),
        ];
      },
      { content: html, batched },
    );
    await page.getByRole('button', { name: 'Make a tiny website' }).click();
    await page.getByLabel('Message your local model').press('Enter');
    await expect(page.getByText(/I stopped a repeated operation/)).toBeVisible();
    const prompts = await page.evaluate(() => (window as unknown as { __aiPrompts: string[] }).__aiPrompts);
    expect(prompts[1]).not.toContain('INVALID_WEBSITE_PAYLOAD');
    expect(prompts[1]).toContain('Original user request: Create /workspace/sites/lunar-garden/index.html');
    if (!batched) {
      expect(prompts[2]).not.toContain(html);
      expect(prompts[2]).toContain('write_file /workspace/sites/lunar-garden/index.html (replace): Saved');
    }
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Edit index.html' })).toHaveText(html);
    await page.evaluate(() => {
      (window as unknown as { __aiResponses: string[] }).__aiResponses = ['It is saved in the volume.'];
    });
    await page.getByLabel('Message your local model').fill('Where is the website?');
    await page.getByLabel('Message your local model').press('Enter');
    await expect(page.getByText('It is saved in the volume.', { exact: true })).toBeVisible();
    const followup = await page.evaluate(() => (window as unknown as { __aiPrompts: string[] }).__aiPrompts.at(-1));
    expect(followup).not.toContain(html);
    expect(followup).toContain('Saved /workspace/sites/lunar-garden/index.html.');
    if (batched) expect(followup).toContain('(replace): Saved');
  });
}

test('context selection defaults to 8K, persists, reloads the cached model and recovers from a failed size', async ({
  page,
}) => {
  const settings = () =>
    page.locator('details:visible').filter({ has: page.locator('summary', { hasText: 'Model settings' }) });
  await settings().locator('summary').click();
  const context = () => page.getByRole('combobox', { name: 'Context size' });
  await expect(context()).toHaveText('8K · default');
  await context().click();
  await page.getByRole('option', { name: '16K', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('opfs-vfs:ai-context-tokens'))).toBe('16384');
  await page.getByRole('button', { name: /Download model.*2\.00 GB/ }).click();
  await expect(page.getByLabel('Message your local model')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __aiInitializations: number[] }).__aiInitializations.at(-1)),
  ).toBe(16384);
  await page.reload();
  await expect(page.getByLabel('Message your local model')).toBeVisible();
  await settings().locator('summary').click();
  await expect(context()).toHaveText('16K');
  expect(
    await page.evaluate(() => (window as unknown as { __aiInitializations: number[] }).__aiInitializations.at(-1)),
  ).toBe(16384);
  await page.evaluate(() => {
    Object.assign(window, { __aiHoldGeneration: true, __aiResponses: ['Hello from the local model.'] });
  });
  await page.getByLabel('Message your local model').fill('Say hello');
  await page.getByLabel('Message your local model').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(context()).toBeDisabled();
  await page.evaluate(() => {
    const state = window as unknown as { __aiHoldGeneration: boolean; __aiResume: () => void; __aiCacheDelay: number };
    state.__aiHoldGeneration = false;
    state.__aiResume();
    state.__aiCacheDelay = 500;
  });
  await expect(page.getByText('Hello from the local model.', { exact: true })).toBeVisible();
  await page.getByLabel('Message your local model').fill('Keep this draft');
  await page.evaluate(() => {
    (window as unknown as { __aiFailLargeContext: boolean }).__aiFailLargeContext = true;
  });
  await context().click();
  await page.getByRole('option', { name: '32K · experimental', exact: true }).click();
  const gate = page.getByRole('region', { name: 'Give your workspace a local model' });
  await expect(gate).toBeVisible();
  await expect(gate.locator('[aria-label="Context size"]')).toBeDisabled();
  await expect(page.getByLabel('Message your local model')).toBeHidden();
  await expect(page.getByRole('alert')).toContainText('Not enough memory');
  await settings().locator('summary').click();
  await context().click();
  await page.getByRole('option', { name: '8K · default', exact: true }).click();
  await expect(page.getByLabel('Message your local model')).toHaveValue('Keep this draft');
  await expect(page.getByText('Hello from the local model.', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __aiInitializations: number[] }).__aiInitializations.at(-1)),
  ).toBe(8192);
  await page.evaluate(() => localStorage.setItem('opfs-vfs:ai-context-tokens', '999999'));
  await page.reload();
  await expect(page.getByLabel('Message your local model')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __aiInitializations: number[] }).__aiInitializations.at(-1)),
  ).toBe(8192);
});

test('chat follows the bottom, preserves reading position, and resumes with Jump to latest', async ({ page }) => {
  await page.getByRole('button', { name: /Download model.*2\.00 GB/ }).click();
  const input = page.getByLabel('Message your local model');
  await expect(input).toBeVisible();
  const history = page.locator('.ai-chat-scroll');
  const distanceFromBottom = () => history.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await page.evaluate(() => {
    Object.assign(window, { __aiResponses: ['A long reply.\n'.repeat(150)] });
  });
  await input.fill('Give me a long reply');
  await input.press('Enter');
  await expect(page.locator('.ai-message.assistant')).toHaveCount(1);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
  await history.evaluate((el) => {
    el.scrollTop = 100;
  });
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  await expect(jump).toBeVisible();
  const position = await history.evaluate((el) => el.scrollTop);
  await page.evaluate(() => {
    Object.assign(window, { __aiHoldGeneration: true, __aiResponses: ['Here is the next reply.\n'.repeat(40)] });
  });
  await input.fill('Continue');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect(await history.evaluate((el) => el.scrollTop)).toBe(position);
  await page.evaluate(() => {
    const state = window as unknown as { __aiHoldGeneration: boolean; __aiResume: () => void };
    state.__aiHoldGeneration = false;
    state.__aiResume();
  });
  await expect(page.locator('.ai-message.assistant')).toHaveCount(2);
  expect(await history.evaluate((el) => el.scrollTop)).toBe(position);
  await jump.click();
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
  await expect(jump).toHaveCount(0);
  await page.evaluate(() => {
    Object.assign(window, { __aiResponses: ['One more reply.\n'.repeat(40)] });
  });
  await input.fill('One more');
  await input.press('Enter');
  await expect(page.locator('.ai-message.assistant')).toHaveCount(3);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
});
