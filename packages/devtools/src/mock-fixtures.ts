import { samplePng, samplePdf, largeLog } from './preview-fixtures.ts';
import type { MockFile, MockVolume } from './mock-state';
const date = Date.UTC(2026, 8, 21, 12, 32);
const file = (path: string, content: string, minutes = 0): MockFile => ({
  path,
  content,
  modified: date - minutes * 60_000,
});

export function fixtures(): MockVolume[] {
  return [
    {
      name: 'workspace.bin',
      state: 'application',
      connection: 'passive',
      files: [
        file(
          '/README.md',
          '# Your persistent workspace\n\nThis is a simulated volume for trying the volume explorer.\n\n## Try it out\n\n- Search for a file by name or path\n- Switch between the discovered volumes\n- Run ls, pwd, or cat README.md in the terminal\n- Dock the panel on any edge\n\nYour application keeps running while you inspect its files.\n',
        ),
        file('/data/settings.json', '{\n  "theme": "system",\n  "autosave": true,\n  "workspace": "Personal"\n}', 12),
        file(
          '/data/projects.json',
          '[\n  { "name": "Launch notes", "status": "draft" },\n  { "name": "Design system", "status": "active" }\n]',
          36,
        ),
        file(
          '/notes/ideas.md',
          '# Ideas\n\nMake local data easier to inspect.\nKeep the app running while debugging.\n',
          91,
        ),
        { ...file('/public/checker.png', ''), bytes: samplePng },
        { ...file('/docs/guide.pdf', ''), bytes: samplePdf },
        file('/logs/large.log', largeLog),
        file('/design/theme.palette', '#bcf478\n#1c2520\n#e9eee6'),
        ...['/data', '/notes', '/public', '/docs', '/logs', '/design'].map((path) => ({
          ...file(path, ''),
          kind: 'directory' as const,
        })),
        file('/notes/todo.txt', 'Review the volume explorer\nTry a second volume\nCheck the mobile layout\n', 5),
        file(
          '/public/logo.svg',
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="24" fill="#bcf478"/></svg>',
          210,
        ),
      ],
    },
    {
      name: 'scratch.bin',
      state: 'available',
      connection: 'none',
      files: [
        file('/hello.txt', 'A second volume, ready to open.\n'),
        file('/experiment.json', '{ "isolated": true }\n', 45),
      ],
    },
    {
      name: 'archive.bin',
      state: 'available',
      connection: 'none',
      files: [file('/notes.txt', 'An older, closed volume.\n', 1440)],
    },
    { name: 'legacy-app.bin', state: 'busy', connection: 'none', files: [] },
    { name: 'private.bin', state: 'protected', connection: 'none', files: [] },
  ];
}
