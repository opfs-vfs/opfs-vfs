import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';

function runPersistenceWorkerScenario(type: string, timeoutMs = 60000) {
  return new Promise<{ check: string; pass: boolean; detail?: string }[]>((resolve, reject) => {
    const worker = new Worker(new URL('./persistence-test-worker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${type} timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(`Worker error: ${e.message}`));
    };
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data.type === 'RESULT') resolve(event.data.results);
      if (event.data.type === 'ERROR') reject(new Error(event.data.error));
    };
    worker.postMessage({ type });
  });
}

describe('OpfsVfsWorker', () => {
  let vfs: OpfsVfsWorker;

  beforeEach(async () => {
    const id = Math.random().toString(36).substring(7);
    vfs = new OpfsVfsWorker(`test-${id}.bin`, { forceLeader: true });
    await vfs.ready;
    // Clear files
    try {
      const entries = (await vfs.readdir('/')).filter((entry) => entry !== '.' && entry !== '..');
      for (const entry of entries) {
        await vfs.remove(`/${entry}`);
      }
    } catch {}
  });

  afterEach(async () => {
    await vfs.closeVfs();
  });

  it('should create a directory', async () => {
    await vfs.mkdir('/testdir');
    const fd = await vfs.open('/testdir/test.txt', true);
    expect(fd).toBeGreaterThan(0);
    await vfs.close(fd);
  });

  it('should write and read data', async () => {
    const fd = await vfs.open('/hello.txt', true);
    const data = new TextEncoder().encode('Hello World');
    await vfs.write(fd, data);
    await vfs.close(fd);

    const fd2 = await vfs.open('/hello.txt', false);
    const { buffer, read } = await vfs.read(fd2, 11);
    expect(new TextDecoder().decode(buffer)).toBe('Hello World');
    expect(read).toBe(11);
    await vfs.close(fd2);
  });

  it('does not detach the caller buffer when writing a subarray view (SEC-1)', async () => {
    // A view into a larger buffer (e.g. an app/Emscripten heap) must not be
    // transferred: doing so would detach the whole backing buffer and corrupt
    // unrelated caller data.
    const parent = new Uint8Array(64);
    for (let i = 0; i < parent.length; i++) parent[i] = i & 0xff;
    const payload = new TextEncoder().encode('Hello View');
    const view = parent.subarray(16, 16 + payload.length);
    view.set(payload);

    const fd = await vfs.open('/subview.txt', true);
    await vfs.write(fd, view);
    await vfs.close(fd);

    // The parent buffer must survive intact (not detached) ...
    expect(parent.byteLength).toBe(64);
    expect(parent.buffer.byteLength).toBe(64);
    // ... including bytes outside the written view.
    expect(parent[0]).toBe(0);
    expect(parent[15]).toBe(15);
    expect(parent[16 + payload.length]).toBe((16 + payload.length) & 0xff);

    // ... and the file must contain exactly the view's bytes.
    const fd2 = await vfs.open('/subview.txt', false);
    const { buffer, read } = await vfs.read(fd2, payload.length);
    expect(read).toBe(payload.length);
    expect(new TextDecoder().decode(buffer)).toBe('Hello View');
    await vfs.close(fd2);
  });

  it('transfers a full-buffer view on write (SEC-1 fast path)', async () => {
    const data = new TextEncoder().encode('Full Buffer');
    const fd = await vfs.open('/fullbuf.txt', true);
    await vfs.write(fd, data);
    await vfs.close(fd);

    // The full-buffer view is transferred, so its backing buffer is detached.
    expect(data.buffer.byteLength).toBe(0);

    const fd2 = await vfs.open('/fullbuf.txt', false);
    const { buffer, read } = await vfs.read(fd2, 11);
    expect(read).toBe(11);
    expect(new TextDecoder().decode(buffer)).toBe('Full Buffer');
    await vfs.close(fd2);
  });

  it('should support recursive mkdir and dot entries', async () => {
    await vfs.mkdir('/nested/a/b', { recursive: true });
    const entries = await vfs.readdir('/nested/a');

    expect(entries).toContain('.');
    expect(entries).toContain('..');
    expect(entries).toContain('b');
  });

  it('should expose typed directory entries and sorted path listings', async () => {
    await vfs.mkdir('/dir');
    const fd = await vfs.open('/dir/file.txt', true);
    await vfs.close(fd);
    await vfs.symlink('file.txt', '/dir/link.txt');

    expect(await vfs.readdirNames('/dir')).toEqual(['file.txt', 'link.txt']);
    expect(await vfs.readdirEntries('/dir')).toEqual([
      { name: 'file.txt', mode: 0o100644, is_dir: false, is_file: true },
      { name: 'link.txt', mode: 0o120777, is_dir: false, is_file: false },
    ]);
    expect(await vfs.listPaths()).toEqual(['/', '/dir', '/dir/file.txt', '/dir/link.txt']);
  });

  it('SEC-2: a malformed numeric message yields a serialized EINVAL error, not a wedged worker', async () => {
    const fd = await vfs.open('/sec2.txt', true);
    await vfs.write(fd, new TextEncoder().encode('hello'));

    // NaN seek offset crosses the worker boundary; getNumber must reject it.
    let caught: (Error & { code?: string }) | undefined;
    try {
      await vfs.seek(fd, Number.NaN, 0);
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught?.code).toBe('EINVAL');

    // The worker is still alive and the fd cursor is intact: a normal read works.
    const { buffer, read } = await vfs.read(fd, 5, 0);
    expect(read).toBe(5);
    expect(new TextDecoder().decode(buffer)).toBe('hello');
    await vfs.close(fd);
  });
});

describe('Metadata persistence (OpfsVfs in Worker)', () => {
  it('should persist files and data across close/reopen', async () => {
    const worker = new Worker(new URL('./persistence-test-worker.ts', import.meta.url), { type: 'module' });

    const result = await new Promise<{ check: string; pass: boolean; detail?: string }[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Persistence test timeout (30s)')), 30000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(`Worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data.type === 'RESULT') resolve(event.data.results);
        if (event.data.type === 'ERROR') reject(new Error(event.data.error));
      };
      worker.postMessage({ type: 'RUN_PERSISTENCE_TEST' });
    });

    worker.terminate();

    // Assert every check passed
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Namespace correctness (OpfsVfs)', () => {
  it('should enforce rename/remove/open semantics', async () => {
    const result = await runPersistenceWorkerScenario('RUN_NAMESPACE_RULES_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Disk growth correctness (OpfsVfs)', () => {
  it('should zero-fill growth and sparse writes in disk mode', async () => {
    const result = await runPersistenceWorkerScenario('RUN_DISK_GROWTH_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Post-flush mutation persistence (OpfsVfs)', () => {
  it('should persist mutations made after flushVfs before closeVfs', async () => {
    const result = await runPersistenceWorkerScenario('RUN_POST_FLUSH_MUTATION_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Default storage settings (OpfsVfs)', () => {
  it('uses disk buffering and automatically persists without an explicit flush', async () => {
    const result = await runPersistenceWorkerScenario('RUN_DEFAULT_AUTO_FLUSH_TEST');
    for (const r of result) expect(r.pass, `${r.check}: ${r.detail ?? ''}`).toBe(true);
  });
});

describe('Disk balanced durability (OpfsVfs)', () => {
  it('should persist disk-mode writes after the balanced debounce window', async () => {
    const result = await runPersistenceWorkerScenario('RUN_DISK_BALANCED_AUTO_FLUSH_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Disk torn-write crash recovery (OpfsVfs)', () => {
  it('repairs meta referencing physically-missing blocks instead of short-reading', async () => {
    const result = await runPersistenceWorkerScenario('RUN_DISK_TORN_WRITE_RECOVERY_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('cuts at the first missing page for non-monotonic block tables', async () => {
    const result = await runPersistenceWorkerScenario('RUN_DISK_TORN_WRITE_NONMONOTONIC_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Atomic meta snapshot swap (INT-1, OpfsVfs)', () => {
  it('does not create the retired single-file .meta snapshot sidecar', async () => {
    const result = await runPersistenceWorkerScenario('RUN_NO_LEGACY_META_SIDECAR_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('rejects a retired single-file .meta snapshot instead of mounting it as fresh', async () => {
    const result = await runPersistenceWorkerScenario('RUN_RETIRED_META_REJECTED_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('recovers the full namespace from the fallback slot when the active snapshot is corrupted', async () => {
    const result = await runPersistenceWorkerScenario('RUN_META_SNAPSHOT_FALLBACK_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('surfaces a typed corruption error for empty meta with non-empty data and no fallback', async () => {
    const result = await runPersistenceWorkerScenario('RUN_META_SNAPSHOT_CORRUPTION_TYPED_ERROR_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Meta log generation binding (INT-2, OpfsVfs)', () => {
  it('discards a stale-generation log replanted over a newer snapshot (no rewind)', async () => {
    const result = await runPersistenceWorkerScenario('RUN_META_LOG_STALE_GENERATION_DISCARDED_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('replays uncheckpointed current-generation records after a crash', async () => {
    const result = await runPersistenceWorkerScenario('RUN_META_LOG_CURRENT_GENERATION_REPLAYS_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Bitmap rebuilt from metadata on mount (INT-4, OpfsVfs)', () => {
  it('hard links: marks shared inode blocks exactly once with no double-claim', async () => {
    const result = await runPersistenceWorkerScenario('RUN_BITMAP_REBUILD_HARDLINK_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Hard-link log recovery (OpfsVfs)', () => {
  it('should replay hard-link metadata updates after a sync-only close', async () => {
    const result = await runPersistenceWorkerScenario('RUN_HARDLINK_LOG_RECOVERY_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Hard-link reopen persistence (OpfsVfs)', () => {
  it('should preserve file hard-link counts across a clean reopen', async () => {
    const result = await runPersistenceWorkerScenario('RUN_HARDLINK_REOPEN_TEST');

    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Memory-mode data WAL recovery (OpfsVfs)', () => {
  it('recovers unflushed writes/truncate across crash-style reopen and checkpoints on sync', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_CRASH_RECOVERY_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('ignores partial trailing data WAL records and salvages a bad-checksum WAL (INT-5)', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_PARTIAL_TRAILING_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('INT-5: salvages a poisoned (apply-throws) record and continues mounting', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_POISON_RECORD_SALVAGE_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('INT-5: salvages mid-WAL CRC corruption, discarding the corrupt frame and everything after', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_MIDLOG_CORRUPTION_SALVAGE_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('§6.2: fail-stop throws a typed corruption error; salvage mounts and stays usable', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_RECOVERY_MODE_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('persists replayed write/truncate data across sync/close and second reopen', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_DURABLE_REOPEN_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('applies replayed deletes to stale namespace metadata', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_DELETE_REPLAY_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);

  it('recovers write+rename and hardlink/unlink crash scenarios by inode identity', async () => {
    const result = await runPersistenceWorkerScenario('RUN_MEMORY_WAL_LINK_RENAME_RECOVERY_TEST');
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});

describe('Large directory stress test (OpfsVfs in Worker)', () => {
  it('should handle 500 files across deep directories', async () => {
    const worker = new Worker(new URL('./stress-test-worker.ts', import.meta.url), { type: 'module' });

    const result = await new Promise<{ check: string; pass: boolean; detail?: string }[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Stress test timeout (60s)')), 60000);
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(`Worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data.type === 'RESULT') resolve(event.data.results);
        if (event.data.type === 'ERROR') reject(new Error(event.data.error));
      };
      worker.postMessage({ type: 'RUN_STRESS_TEST' });
    });

    worker.terminate();

    // Log timing details
    for (const r of result) {
      if (r.detail) console.log(`${r.check}: ${r.detail}`);
    }

    // Assert every check passed
    for (const r of result) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 90000);
});
