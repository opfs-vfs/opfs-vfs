import { deleteVolume } from '../index.js';
import { OpenFlags, OpfsVfs } from '../opfs-vfs.js';

export type Section = { name: string; failures: string[] };

const text = new TextEncoder();
const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;

function put(vfs: OpfsVfs, path: string, content: string) {
  const fd = vfs.openSync(path, create);
  try {
    vfs.writeSync(fd, text.encode(content), 0);
  } finally {
    vfs.closeSync(fd);
  }
}

function read(vfs: OpfsVfs, path: string) {
  const fd = vfs.openSync(path);
  try {
    return new TextDecoder().decode(vfs.readSync(fd, 1024, 0).buffer);
  } finally {
    vfs.closeSync(fd);
  }
}

/** The error code an operation fails with, or its result as text. */
function outcome(operation: () => unknown): string {
  try {
    const value = operation();
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch (error) {
    return String((error as { code?: unknown }).code ?? error);
  }
}

/**
 *   /x "ROOTX"   /file "FILE"
 *   /a/x "X"     /a/b/f "F"
 *   /link -> /a/b            /a/rel -> b            /a/b/up -> ../x
 *   /dangling -> /nowhere    /loop1 -> /loop2       /loop2 -> /loop1
 *   /p/y "Y"     /p/q/ (made unsearchable)          /plink -> /p/q
 */
function build(vfs: OpfsVfs) {
  vfs.mkdirSync('/a');
  vfs.mkdirSync('/a/b');
  put(vfs, '/a/b/f', 'F');
  put(vfs, '/a/x', 'X');
  put(vfs, '/x', 'ROOTX');
  put(vfs, '/file', 'FILE');
  vfs.symlinkSync('/a/b', '/link');
  vfs.symlinkSync('b', '/a/rel');
  vfs.symlinkSync('../x', '/a/b/up');
  vfs.symlinkSync('/nowhere', '/dangling');
  vfs.symlinkSync('/loop2', '/loop1');
  vfs.symlinkSync('/loop1', '/loop2');
  vfs.mkdirSync('/p');
  vfs.mkdirSync('/p/q');
  put(vfs, '/p/y', 'Y');
  vfs.symlinkSync('/p/q', '/plink');
}

async function run(bufferMode: 'disk' | 'memory'): Promise<Section[]> {
  const name = `path-resolution-${crypto.randomUUID()}.bin`;
  const sections: Section[] = [];
  let failures: string[] = [];
  const section = (title: string, body: () => void) => {
    failures = [];
    body();
    sections.push({ name: title, failures });
  };
  const expect = (label: string, operation: () => unknown, expected: unknown) => {
    const actual = outcome(operation);
    const wanted = typeof expected === 'string' ? expected : JSON.stringify(expected);
    if (actual !== wanted) failures.push(`${label}: got ${actual}, expected ${wanted}`);
  };

  let vfs = new OpfsVfs(name, { noatime: true, bufferMode });
  await vfs.ready;
  try {
    build(vfs);
    const isDir = (path: string, follow = true) => (follow ? vfs.statSync(path) : vfs.lstatSync(path)).is_dir;
    const isLink = (path: string) => (vfs.lstatSync(path).mode & 0o170000) === 0o120000;

    section('dot-dot after a symlink to a directory is the parent of its target', () => {
      expect('read /link/../x', () => read(vfs, '/link/../x'), 'X');
      expect('read /a/rel/../x', () => read(vfs, '/a/rel/../x'), 'X');
      expect('realpath /link/../x', () => vfs.realpathSync('/link/../x'), '/a/x');
      expect('realpath /link/..', () => vfs.realpathSync('/link/..'), '/a');
      expect('readdir /link/..', () => vfs.readdirNamesSync('/link/..'), ['b', 'rel', 'x']);
      expect('exists /link/../x', () => vfs.existsSync('/link/../x'), true);
      expect('a relative target is walked from its link: read /a/b/up', () => read(vfs, '/a/b/up'), 'X');
      expect('realpath /link/up', () => vfs.realpathSync('/link/up'), '/a/x');
    });

    section('dot components need a directory and change nothing', () => {
      expect('read /a/./b/./f', () => read(vfs, '/a/./b/./f'), 'F');
      expect('realpath /a/b/.', () => vfs.realpathSync('/a/b/.'), '/a/b');
      expect('realpath /a/b/..', () => vfs.realpathSync('/a/b/..'), '/a');
      expect('realpath /a/b/../b/f', () => vfs.realpathSync('/a/b/../b/f'), '/a/b/f');
    });

    section('dot-dot at the root stays at the root', () => {
      expect('realpath /..', () => vfs.realpathSync('/..'), '/');
      expect('realpath /../..', () => vfs.realpathSync('/../..'), '/');
      expect('realpath /a/../..', () => vfs.realpathSync('/a/../..'), '/');
      expect('read /../x', () => read(vfs, '/../x'), 'ROOTX');
    });

    section('a dot component after a missing name is ENOENT', () => {
      expect('stat /missing/../file', () => vfs.statSync('/missing/../file'), 'ENOENT');
      expect('stat /missing/./file', () => vfs.statSync('/missing/./file'), 'ENOENT');
      expect('open /missing/../file', () => vfs.openSync('/missing/../file'), 'ENOENT');
      expect('create /missing/../new', () => vfs.openSync('/missing/../new', create), 'ENOENT');
      expect('mkdir /missing/../dir', () => vfs.mkdirSync('/missing/../dir'), 'ENOENT');
      expect('exists /missing/../file', () => vfs.existsSync('/missing/../file'), false);
      expect('nothing was created', () => vfs.existsSync('/new') || vfs.existsSync('/dir'), false);
    });

    section('a dot component after a file is ENOTDIR', () => {
      expect('stat /file/..', () => vfs.statSync('/file/..'), 'ENOTDIR');
      expect('stat /file/.', () => vfs.statSync('/file/.'), 'ENOTDIR');
      expect('read /file/../x', () => read(vfs, '/file/../x'), 'ENOTDIR');
      expect('readdir /file/..', () => vfs.readdirNamesSync('/file/..'), 'ENOTDIR');
      expect('exists /file/..', () => vfs.existsSync('/file/..'), false);
      // The walk itself refuses it, whatever the operation would say about the file.
      expect('readlink /file/.', () => vfs.readlinkSync('/file/.'), 'ENOTDIR');
    });

    section('dangling symlinks and loops', () => {
      expect('lstat /dangling is the link', () => isLink('/dangling'), true);
      expect('stat /dangling/..', () => vfs.statSync('/dangling/..'), 'ENOENT');
      expect('exists /dangling/..', () => vfs.existsSync('/dangling/..'), false);
      expect('lstat /loop1 is the link', () => isLink('/loop1'), true);
      expect('stat /loop1', () => vfs.statSync('/loop1'), 'ELOOP');
      expect('stat /loop1/..', () => vfs.statSync('/loop1/..'), 'ELOOP');
      expect('exists /loop1/..', () => vfs.existsSync('/loop1/..'), false);
    });

    section('every directory the walk passes through must be searchable', () => {
      expect('read /plink/../y while /p/q is searchable', () => read(vfs, '/plink/../y'), 'Y');
      vfs.chmodSync('/p/q', 0o600);
      // The result /p/y does not contain /p/q, but the walk goes through it.
      expect('stat /plink/../y', () => vfs.statSync('/plink/../y'), 'EACCES');
      expect('stat /p/q/../y', () => vfs.statSync('/p/q/../y'), 'EACCES');
      expect('stat /p/q/.', () => vfs.statSync('/p/q/.'), 'EACCES');
      expect('exists /plink/../y', () => vfs.existsSync('/plink/../y'), false);
      expect('read /p/y', () => read(vfs, '/p/y'), 'Y');
    });

    section('the final component: stat follows a symlink, lstat does not', () => {
      expect('stat /link', () => isDir('/link'), true);
      expect('lstat /link', () => isLink('/link'), true);
      expect('lstat /link/. follows the link, which is no longer final', () => isDir('/link/.', false), true);
      expect('lstat /link/../rel is the link /a/rel', () => isLink('/link/../rel'), true);
      expect('readlink /link/../rel', () => vfs.readlinkSync('/link/../rel'), 'b');
      expect('stat /a/ (trailing slash on a directory)', () => isDir('/a/'), true);
      expect('stat /file/ (trailing slash on a file)', () => vfs.statSync('/file/'), 'ENOTDIR');
    });

    section('creating, linking, renaming and removing through dot-dot act on the resolved location', () => {
      put(vfs, '/link/../created', 'C');
      expect('create /link/../created', () => read(vfs, '/a/created'), 'C');
      expect('open without O_CREAT /link/../nope', () => vfs.openSync('/link/../nope'), 'ENOENT');
      vfs.mkdirSync('/link/../dir');
      expect('mkdir /link/../dir', () => isDir('/a/dir'), true);
      vfs.mkdirSync('/a/p/q/../r', { recursive: true });
      expect('mkdir -p /a/p/q/../r', () => vfs.readdirNamesSync('/a/p'), ['q', 'r']);
      vfs.symlinkSync('/x', '/link/../sym');
      expect('symlink at /link/../sym', () => vfs.readlinkSync('/a/sym'), '/x');
      vfs.linkSync('/link/../x', '/link/../hard');
      expect('link /link/../x to /link/../hard', () => vfs.statSync('/a/hard').ino === vfs.statSync('/a/x').ino, true);
      vfs.renameSync('/link/../created', '/link/../renamed');
      expect('rename source and destination', () => [vfs.existsSync('/a/created'), read(vfs, '/a/renamed')], [
        false,
        'C',
      ]);
      vfs.unlinkSync('/link/../renamed');
      vfs.rmdirSync('/link/../dir');
      expect('unlink and rmdir', () => [vfs.existsSync('/a/renamed'), vfs.existsSync('/a/dir')], [false, false]);
      expect('the root entries are untouched', () => [read(vfs, '/x'), vfs.existsSync('/created')], ['ROOTX', false]);
    });

    section('removing or renaming . or .. is EINVAL and changes nothing', () => {
      vfs.mkdirSync('/t');
      vfs.mkdirSync('/t/sub');
      put(vfs, '/t/sub/g', 'G');
      vfs.symlinkSync('/t/sub', '/tl');
      const tree = () => [vfs.listPathsSync(), vfs.readlinkSync('/tl'), read(vfs, '/t/sub/g')];
      const before = tree();
      for (const dot of ['.', '..', './']) {
        for (const base of ['/t/sub', '/tl']) {
          const target = `${base}/${dot}`;
          expect(`remove ${target}`, () => vfs.removeSync(target), 'EINVAL');
          expect(`rmdir ${target}`, () => vfs.rmdirSync(target), 'EINVAL');
          expect(`rename ${target} (source)`, () => vfs.renameSync(target, '/t/moved'), 'EINVAL');
          expect(`rename ${target} (destination)`, () => vfs.renameSync('/t/sub/g', target), 'EINVAL');
        }
      }
      // unlink has no such hazard: a directory is refused, whatever it is reached through.
      expect('unlink /tl/.', () => vfs.unlinkSync('/tl/.'), 'EISDIR');
      expect('the link, its target and the contents are intact', tree, before);
    });

    section('a directory cannot be moved into its own subtree through .. or a symlink', () => {
      vfs.mkdirSync('/m');
      vfs.mkdirSync('/m/b');
      vfs.mkdirSync('/m/sub');
      vfs.symlinkSync('/m', '/mlink');
      const before = vfs.listPathsSync();
      expect('rename /m /m/b/../moved', () => vfs.renameSync('/m', '/m/b/../moved'), 'EINVAL');
      expect('rename /m /mlink/sub/moved', () => vfs.renameSync('/m', '/mlink/sub/moved'), 'EINVAL');
      expect('rename /mlink/. through the link', () => vfs.renameSync('/mlink/.', '/m/sub/moved'), 'EINVAL');
      expect('the tree is intact', () => vfs.listPathsSync(), before);
    });

    section('a chain of 40 symlinks resolves and 41 fails with ELOOP', () => {
      // /c1 -> /c2 -> ... -> /c41 -> /file
      for (let i = 1; i <= 41; i++) vfs.symlinkSync(i === 41 ? '/file' : `/c${i + 1}`, `/c${i}`);
      expect('stat /c2 (40 links)', () => vfs.statSync('/c2').size, 4);
      expect('read /c2', () => read(vfs, '/c2'), 'FILE');
      expect('stat /c1 (41 links)', () => vfs.statSync('/c1'), 'ELOOP');
      expect('lstat /c1 is still the link', () => isLink('/c1'), true);
      for (let i = 1; i <= 41; i++) vfs.unlinkSync(`/c${i}`);
    });

    section('subscription targets reject . and .. components, and are not file lookups', () => {
      const validate = (path: string, scope: 'file' | 'directory') => {
        (
          vfs as unknown as { validateChangeTarget(target: { path: string; scope: string; recursive: boolean }): void }
        ).validateChangeTarget({ path, scope, recursive: false });
        return 'accepted';
      };
      // A `.` or `..` component is rejected, so a target never silently names a different path than a file call.
      for (const path of ['/link/../x', '/a/./b', '/a/../b', '/..', '/.', '/a/b/.', '/a/b/..', 'a/./b'])
        for (const scope of ['file', 'directory'] as const)
          expect(`${scope} target ${path} is rejected`, () => validate(path, scope), 'EINVAL');
      // Only whole components count; dotted names and not-yet-existing targets are fine.
      for (const path of ['/a/.b', '/a/b..', '/a/...', '/a/..b', '/not/yet/created'])
        expect(`file target ${path}`, () => validate(path, 'file'), 'accepted');
      expect('directory target with trailing slash', () => validate('/a//b/', 'directory'), 'accepted');
      expect('a target through a symlink is still refused', () => validate('/link/f', 'file'), 'EINVAL');
    });

    const canonical = [
      '/',
      '/a',
      '/a/b',
      '/a/b/f',
      '/a/b/up',
      '/a/hard',
      '/a/p',
      '/a/p/q',
      '/a/p/r',
      '/a/rel',
      '/a/sym',
      '/a/x',
      '/dangling',
      '/file',
      '/link',
      '/loop1',
      '/loop2',
      '/m',
      '/m/b',
      '/m/sub',
      '/mlink',
      '/p',
      '/p/q',
      '/p/y',
      '/plink',
      '/t',
      '/t/sub',
      '/t/sub/g',
      '/tl',
      '/x',
    ];
    section('recorded paths are canonical, also after a reopen', () => {
      expect('paths before close', () => vfs.listPathsSync(), canonical);
    });
    // An incremental log record (sync), then the snapshot (close).
    put(vfs, '/link/../logged', 'L');
    vfs.syncSync();
    await vfs.closeVfs();
    vfs = new OpfsVfs(name, { noatime: true, bufferMode });
    await vfs.ready;
    failures = sections[sections.length - 1]!.failures;
    expect('paths after reopen', () => vfs.listPathsSync(), [...canonical, '/a/logged'].sort());
    expect('content after reopen', () => read(vfs, '/a/b/../logged'), 'L');
  } finally {
    await vfs.closeVfs();
    await deleteVolume(name);
  }
  return sections;
}

self.onmessage = async ({ data }: MessageEvent<{ bufferMode: 'disk' | 'memory' }>) => {
  try {
    self.postMessage({ sections: await run(data.bufferMode) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
};
