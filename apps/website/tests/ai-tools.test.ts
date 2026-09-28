import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryFs } from 'just-bash/browser';
import { createAiShell, executeAiTool, parseAiTool, parseAiTools, validateAiCommand } from '../src/lib/ai/tools.ts';

void test('AI writes, overwrites, appends and copies literal files in its volume', async () => {
  const shell = createAiShell(new InMemoryFs());
  const signal = new AbortController().signal;
  const execute = (json: object) => {
    const tool = parseAiTool(JSON.stringify(json));
    assert.ok(tool);
    return executeAiTool(shell, tool, signal);
  };
  const path = '/workspace/poems/été poem.md';
  const content = "# Poem\nIt's $(touch /injected); `touch /injected2`\n";
  await execute({ tool: 'write_file', path, content });
  assert.equal(await shell.fs.readFile(path), content);
  assert.equal(await shell.fs.exists('/injected'), false);
  assert.equal(await shell.fs.exists('/injected2'), false);
  await execute({ tool: 'write_file', path, content: 'Replacement' });
  await execute({ tool: 'write_file', path, content: '\nLast line', append: true });
  assert.equal(await shell.fs.readFile(path), 'Replacement\nLast line');
  assert.equal((await execute({ tool: 'cp', command: `cp '${path}' /workspace/copy.txt` })).ok, true);
  assert.equal(await shell.fs.readFile('/workspace/copy.txt'), 'Replacement\nLast line');
  assert.equal((await execute({ tool: 'bash', command: 'cp -r /workspace/poems /workspace/backup' })).ok, true);
  assert.equal(await shell.fs.readFile('/workspace/backup/été poem.md'), 'Replacement\nLast line');
  const command = "cat > /workspace/poem.md <<'EOF'\nThe wind whispers. $(touch /injected)\nEOF";
  assert.equal((await execute({ tool: 'cat', command })).ok, true);
  assert.equal(await shell.fs.readFile('/workspace/poem.md'), 'The wind whispers. $(touch /injected)\n');
  await execute({ tool: 'cat', command });
  assert.equal(await shell.fs.readFile('/workspace/poem.md'), 'The wind whispers. $(touch /injected)\n');
  assert.equal(await shell.fs.exists('/injected'), false);
  assert.equal((await execute({ tool: 'open_file', path: 'poem.md' })).selectedPath, '/workspace/poem.md');
  assert.equal((await execute({ tool: 'bash', command: 'cp /missing /workspace/copy.txt' })).ok, false);
  assert.equal(await shell.fs.readFile('/workspace/copy.txt'), 'Replacement\nLast line');
});

void test('tool boundaries reject invalid input and unavailable host or network access', async () => {
  const shell = createAiShell(new InMemoryFs());
  for (const command of [
    'curl https://example.com',
    'wget https://example.com',
    'python3 -c "print(1)"',
    'js-exec "1+1"',
    'cat /etc/passwd',
  ]) {
    const result = await executeAiTool(shell, { tool: 'bash', command }, new AbortController().signal);
    assert.equal(result.ok, false, command);
  }
  for (const command of ['', '  ', '\0']) assert.throws(() => validateAiCommand(command));
  assert.throws(() => parseAiTool('{"tool":"eval","code":"alert(1)"}'));
  assert.throws(() => parseAiTool(JSON.stringify({ tool: 'write_file', path: 'a', content: 'a'.repeat(65537) })));
  assert.throws(() => parseAiTool(JSON.stringify({ tool: 'write_file', path: 'a', content: 'a', append: 'yes' })));
  assert.throws(() => parseAiTool(JSON.stringify({ tool: 'open_file', path: '\0' })));
  assert.throws(() => validateAiCommand('a'.repeat(65537)));
});

void test('batches validate all tools and remaining budget before execution', () => {
  const write = { tool: 'write_file', path: 'a', content: 'a' };
  assert.throws(() => parseAiTools(JSON.stringify([write, { tool: 'bash', command: '\0' }])));
  assert.throws(() => parseAiTools(JSON.stringify([write, write]), 1));
  assert.throws(() => parseAiTools('[]'));
  assert.throws(() => parseAiTools(JSON.stringify(write) + ' Claimed success.'));
  assert.throws(() => parseAiTools('```json\n' + JSON.stringify(write)));
});

void test('structured copy preserves quoted names and read output is never silently truncated', async () => {
  const shell = createAiShell(new InMemoryFs());
  const signal = new AbortController().signal;
  await shell.fs.mkdir('/workspace', { recursive: true });
  const content = 'a'.repeat(8050) + 'DO_NOT_DROP';
  await shell.fs.writeFile("/workspace/author's poem.md", content);
  const tool = parseAiTool(JSON.stringify({ tool: 'cp', source: "author's poem.md", destination: "author's copy.md" }));
  assert.ok(tool);
  assert.equal((await executeAiTool(shell, tool, signal)).ok, true);
  assert.equal(await shell.fs.readFile("/workspace/author's copy.md"), content);
  const read = await executeAiTool(shell, { tool: 'bash', command: `cat "/workspace/author's copy.md"` }, signal);
  assert.equal(read.ok, true);
  assert.ok(read.observation.includes(content));
  await shell.fs.writeFile('/workspace/large', 'a'.repeat(9000));
  const overflow = await executeAiTool(shell, { tool: 'bash', command: 'cat /workspace/large' }, signal);
  assert.equal(overflow.ok, false);
  assert.match(overflow.observation, /output size exceeded/);
});

void test('full volume file operations support rename, move, edit, search and deletion', async () => {
  const shell = createAiShell(new InMemoryFs());
  const signal = new AbortController().signal;
  const run = (command: string) => executeAiTool(shell, { tool: 'bash', command }, signal);
  await shell.fs.mkdir('/workspace', { recursive: true });
  await shell.fs.writeFile('/workspace/poem.md', 'old poem');
  assert.equal((await run('mv /workspace/poem.md /workspace/renamed.md')).ok, true);
  assert.equal(await shell.fs.exists('/workspace/poem.md'), false);
  assert.equal(
    (
      await run(
        "mkdir -p /workspace/folder; mv /workspace/renamed.md /workspace/folder/poem.md; sed -i 's/old/new/' /workspace/folder/poem.md",
      )
    ).ok,
    true,
  );
  assert.equal(await shell.fs.readFile('/workspace/folder/poem.md'), 'new poem');
  assert.match((await run('find /workspace -name "*.md" | sort')).observation, /folder\/poem.md/);
  assert.equal((await run('cp -r /workspace/folder /workspace/copied; rm -r /workspace/folder')).ok, true);
  assert.equal(await shell.fs.exists('/workspace/folder'), false);
  assert.equal(await shell.fs.readFile('/workspace/copied/poem.md'), 'new poem');
  assert.equal((await run('rm /workspace/copied/poem.md; rmdir /workspace/copied')).ok, true);
  assert.equal(await shell.fs.exists('/workspace/copied'), false);
});

void test('captured structured rm deletes literal paths and requires explicit recursive deletion', async () => {
  const shell = createAiShell(new InMemoryFs({ '/workspace/notes.txt': 'Disposable fixture' }));
  const signal = new AbortController().signal;
  const run = async (raw: string) => {
    const tools = parseAiTools(raw);
    assert.ok(tools);
    for (const tool of tools) assert.equal((await executeAiTool(shell, tool, signal)).ok, true);
  };
  await run('```json\n{"tool":"rm","path":"notes.txt"}\n```');
  assert.equal(await shell.fs.exists('/workspace/notes.txt'), false);
  await assert.rejects(run('{"tool":"rm","path":"notes.txt"}'));
  const path = "- author's $(touch injected); *.txt";
  await shell.fs.writeFile(`/workspace/${path}`, 'Literal filename');
  await shell.fs.writeFile('/workspace/keep.txt', 'Keep me');
  await run(JSON.stringify({ tool: 'delete_file', path }));
  assert.equal(await shell.fs.exists(`/workspace/${path}`), false);
  assert.equal(await shell.fs.readFile('/workspace/keep.txt'), 'Keep me');
  assert.equal(await shell.fs.exists('/workspace/injected'), false);
  await shell.fs.mkdir('/workspace/folder', { recursive: true });
  await shell.fs.writeFile('/workspace/folder/keep.txt', 'Keep until recursive');
  await assert.rejects(run('{"tool":"rm","path":"folder"}'));
  assert.equal(await shell.fs.readFile('/workspace/folder/keep.txt'), 'Keep until recursive');
  for (const extra of [{ recursive: 'false' }, { flags: '-r' }, { force: true }, { command: 'rm keep.txt' }])
    assert.throws(() => parseAiTools(JSON.stringify({ tool: 'rm', path: 'folder', ...extra })));
  for (const path of ['', '\0', 'x'.repeat(4097)])
    assert.throws(() => parseAiTools(JSON.stringify({ tool: 'rm', path })));
  await run('{"tool":"rm","path":"folder","recursive":true}');
  assert.equal(await shell.fs.exists('/workspace/folder'), false);
  await run('{"tool":"rm","command":"rm /workspace/keep.txt"}');
  assert.equal(await shell.fs.exists('/workspace/keep.txt'), false);
});
