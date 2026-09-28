import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const list = (filters = []) =>
  JSON.parse(run('pnpm', [...filters, 'list', '--recursive', '--depth', '-1', '--json'])).filter(
    (pkg) => resolve(pkg.path) !== process.cwd(),
  );
const workspaces = list();
if (!workspaces.length) throw new Error('No workspace packages found.');
const all = workspaces.map((pkg) => pkg.name).sort();
const roots = workspaces.map((pkg) => ({ name: pkg.name, path: `${relative(process.cwd(), pkg.path)}/` }));
const isDoc = (path) => /^(?:README\.md|CHANGELOG\.md|(?:docs|agents|\.changeset)\/.*\.md)$/.test(path);
let selected = all;

if (process.env.BASE_SHA) {
  try {
    const changed = run('git', ['diff', '--no-renames', '--name-only', '-z', `${process.env.BASE_SHA}...HEAD`])
      .split('\0')
      .filter(Boolean)
      .filter((path) => !isDoc(path));
    if (!changed.length) {
      selected = [];
    } else if (
      changed.every((path) => roots.some((root) => path.startsWith(root.path) && path !== `${root.path}package.json`))
    ) {
      const affected = list(['--filter', `...[${process.env.BASE_SHA}]`]).map((pkg) => pkg.name);
      const owners = roots.filter((root) => changed.some((path) => path.startsWith(root.path)));
      // Unknown or incomplete selections must not turn a source change into a green skip.
      if (affected.every((name) => all.includes(name)) && owners.every((root) => affected.includes(root.name))) {
        selected = affected.sort();
      }
    }
  } catch (error) {
    console.error(`Cannot determine affected packages; running all tests: ${error.message}`);
  }
}

console.log(JSON.stringify(selected));
