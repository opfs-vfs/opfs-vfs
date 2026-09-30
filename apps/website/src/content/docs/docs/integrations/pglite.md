---
title: PGlite on OPFS · Persistent browser Postgres
description: Store a PGlite Postgres database in OPFS VFS. Configure synchronization and worker lifecycle for a persistent in-browser database.
---

```sh
npm install @opfs-vfs/opfs-vfs @electric-sql/pglite
```

Use the PGlite adapter to store database files in an OPFS VFS volume. Run the synchronous adapter in a dedicated worker:

```ts
import { PGlite } from '@electric-sql/pglite';
import { OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsPGliteAdapter } from '@opfs-vfs/opfs-vfs/pglite';

const volume = new OpfsVfs('database.bin', {
  bufferMode: 'memory',
  localDurabilityMode: 'balanced',
});
await volume.ready;
const pg = await PGlite.create({
  fs: new OpfsVfsPGliteAdapter(volume, { relaxedDurability: false }),
  relaxedDurability: false,
});
await pg.exec('CREATE TABLE IF NOT EXISTS notes (body text)');
await pg.query('INSERT INTO notes VALUES ($1)', ['A garden on the moon.']);
console.log(await pg.query('SELECT * FROM notes'));
await pg.syncToFs();
await pg.close();
await volume.closeVfs();
```

Both durability flags are explicit here so that `await pg.syncToFs()` waits for VFS synchronization. The adapter defaults to relaxed durability. See [storage modes explained](/benchmarks/storage/) for the difference between PGlite durability, VFS buffering, and local durability.

For multiple tabs, use PGlite’s worker leader election and create the direct `OpfsVfs` inside its elected worker. A follower cannot use synchronous filesystem calls. The [website playground](/demos/pglite/) follows this approach and integrates PGlite’s official REPL.

The site pins PGlite 0.5.4 with REPL 0.4.4. Its two dependency patches and browser checks are documented in `apps/website/README.md`; retest adapter and worker behavior before upgrading.

PGlite memory is temporary. PGlite OPFS AHP, IndexedDB, and OPFS VFS are distinct storage backends. OPFS VFS memory buffering still persists to OPFS when synchronized. Use the [benchmark runner](/benchmarks/run/) for the four-way comparison.

Export/import uses PGlite’s data-directory archive, not a raw OPFS VFS volume. Resetting a persistent volume requires other tabs to release it first.
