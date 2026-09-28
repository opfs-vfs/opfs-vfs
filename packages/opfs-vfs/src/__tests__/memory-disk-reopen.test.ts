import { expect, it } from 'vitest';

import { deleteVolume, OpenFlags } from '../index';
import { OpfsVfsWorker } from '../index_internal';

const BLOCK_SIZE = 4096;

async function writeFile(vfs: OpfsVfsWorker, path: string, data: Uint8Array) {
  const fd = await vfs.open(path, OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  try {
    expect(await vfs.write(fd, data.slice())).toBe(data.length);
    await expectFile(vfs, path, data);
  } finally {
    await vfs.close(fd);
  }
}

async function expectFile(vfs: OpfsVfsWorker, path: string, data: Uint8Array) {
  expect((await vfs.stat(path)).size).toBe(data.length);
  const fd = await vfs.open(path);
  try {
    const result = await vfs.read(fd, data.length + 1);
    expect(result.read).toBe(data.length);
    expect(result.buffer).toEqual(data);
  } finally {
    await vfs.close(fd);
  }
}

for (const size of [0, 1, 7, 4095, 4096, 4097, 8199]) {
  it(`preserves ${size} bytes across clean memory-to-disk reopens`, async () => {
    const name = `memory-disk-${crypto.randomUUID()}.bin`;
    const data =
      size === 7 ? new TextEncoder().encode('present') : Uint8Array.from({ length: size }, (_, i) => i % 251);
    try {
      const memory = new OpfsVfsWorker(name, { bufferMode: 'memory' });
      try {
        await memory.ready;
        await writeFile(memory, '/sentinel', data);
      } finally {
        await memory.closeVfs();
      }

      for (let reopen = 0; reopen < 2; reopen++) {
        const disk = new OpfsVfsWorker(name, { bufferMode: 'disk' });
        try {
          await disk.ready;
          await expectFile(disk, '/sentinel', data);
        } finally {
          await disk.closeVfs();
        }
      }
      const root = await navigator.storage.getDirectory();
      const physical = await (await root.getFileHandle(name)).getFile();
      // Block 0 is reserved; a fresh single-file volume needs no other blocks.
      expect(physical.size).toBe(size === 0 ? 0 : (Math.ceil(size / BLOCK_SIZE) + 1) * BLOCK_SIZE);
      if (size % BLOCK_SIZE) {
        const padding = BLOCK_SIZE - (size % BLOCK_SIZE);
        expect(new Uint8Array(await physical.slice(-padding).arrayBuffer())).toEqual(new Uint8Array(padding));
      }
    } finally {
      await deleteVolume(name);
    }
  }, 15_000);
}

it('pads a reused lower block without overwriting its neighbor after shrink and sync', async () => {
  const name = `memory-disk-${crypto.randomUUID()}.bin`;
  const data = new Uint8Array(BLOCK_SIZE + 7).fill(23);
  const guard = new Uint8Array(BLOCK_SIZE).fill(42);
  try {
    const memory = new OpfsVfsWorker(name, { bufferMode: 'memory', localDurabilityMode: 'relaxed' });
    try {
      await memory.ready;
      await writeFile(memory, '/hole', guard);
      await writeFile(memory, '/sentinel', data.subarray(0, BLOCK_SIZE));
      await writeFile(memory, '/guard', guard);
      await memory.sync();
      await memory.unlink('/hole');
      const fd = await memory.open('/sentinel', OpenFlags.O_RDWR);
      await memory.write(fd, new Uint8Array(BLOCK_SIZE).fill(23), BLOCK_SIZE);
      await memory.ftruncate(fd, data.length);
      await memory.close(fd);
      await memory.sync();
      await expectFile(memory, '/sentinel', data);
    } finally {
      await memory.closeVfs();
    }
    const disk = new OpfsVfsWorker(name, { bufferMode: 'disk' });
    try {
      await disk.ready;
      await expectFile(disk, '/sentinel', data);
      await expectFile(disk, '/guard', guard);
    } finally {
      await disk.closeVfs();
    }
  } finally {
    await deleteVolume(name);
  }
}, 15_000);

it('still drops a genuinely truncated physical tail on disk reopen', async () => {
  const name = `memory-disk-${crypto.randomUUID()}.bin`;
  const data = new Uint8Array(2 * BLOCK_SIZE + 7).fill(31);
  try {
    const memory = new OpfsVfsWorker(name, { bufferMode: 'memory' });
    try {
      await memory.ready;
      await writeFile(memory, '/sentinel', data);
    } finally {
      await memory.closeVfs();
    }
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    const size = (await handle.getFile()).size;
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.truncate(Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE - BLOCK_SIZE + 3);
    await writable.close();
    for (let reopen = 0; reopen < 2; reopen++) {
      const disk = new OpfsVfsWorker(name, { bufferMode: 'disk' });
      try {
        await disk.ready;
        await expectFile(disk, '/sentinel', data.subarray(0, 2 * BLOCK_SIZE));
      } finally {
        await disk.closeVfs();
      }
    }
  } finally {
    await deleteVolume(name);
  }
}, 15_000);
