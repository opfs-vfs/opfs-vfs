/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';
import { OpfsVfsPGliteAdapter } from '@opfs-vfs/opfs-vfs/pglite';
import { OpfsVfs } from '@opfs-vfs/opfs-vfs';
type Meta = {
  backend?: 'memory';
  volumeName?: string;
  bufferMode?: 'memory' | 'disk';
  durability?: 'relaxed' | 'balanced' | 'strict';
  createNew?: boolean;
};
await worker({
  async init(options) {
    const meta = options.meta as Meta;
    const { meta: _meta, id: _id, ...cleanOptions } = options;
    if (meta.backend === 'memory') return PGlite.create(cleanOptions);
    if (!meta.volumeName || !meta.bufferMode || !meta.durability)
      throw new Error('Missing persistent database options.');
    const vfs = new OpfsVfs(meta.volumeName, {
      bufferMode: meta.bufferMode,
      localDurabilityMode: meta.durability,
      openMode: meta.createNew ? 'create-new' : undefined,
    });
    await vfs.ready;
    try {
      return await PGlite.create({
        ...cleanOptions,
        fs: new OpfsVfsPGliteAdapter(vfs, { relaxedDurability: meta.durability === 'relaxed' }),
      });
    } catch (error) {
      await vfs.closeVfs();
      throw error;
    }
  },
});
