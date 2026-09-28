/**
 * PERF-6 unit tests for the word-level Bitmap allocator: full-word skipping,
 * partial last word, allocRun spanning word boundaries, free + realloc, and the
 * next-free-hint behavior. Bitmap is pure JS (no SyncAccessHandle) so these run
 * in the default environment without a worker.
 */

import { describe, expect, it } from 'vitest';
import { Bitmap } from '../opfs-vfs';

describe('Bitmap.alloc (PERF-6 word scan)', () => {
  it('hands out sequential blocks starting after the reserved block 0', () => {
    const bm = new Bitmap(128);
    const got: number[] = [];
    for (let i = 0; i < 10; i++) got.push(bm.alloc());
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('skips fully-allocated words and finds the next free bit across a word boundary', () => {
    // Fill the first word entirely (blocks 0..31), so block 32 (word 1) is next.
    const bm = new Bitmap(128);
    for (let i = 0; i < 31; i++) bm.alloc(); // blocks 1..31 (0 already reserved)
    expect(bm.alloc()).toBe(32); // crosses into word 1
    expect(bm.alloc()).toBe(33);
  });

  it('returns -1 only when truly full (partial last word)', () => {
    // totalBlocks not a multiple of 32 → last word is partial.
    const bm = new Bitmap(40); // blocks 0..39; word 1 holds bits for 32..39
    const allocated = new Set<number>();
    let b = bm.alloc();
    while (b >= 0) {
      expect(allocated.has(b)).toBe(false); // never double-hand a block
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThan(40); // never past totalBlocks despite padding bits
      allocated.add(b);
      b = bm.alloc();
    }
    expect(allocated.size).toBe(39); // 40 blocks minus reserved 0
    expect(bm.alloc()).toBe(-1);
  });

  it('reuses freed blocks (free + realloc), preferring the lowest via the hint', () => {
    const bm = new Bitmap(128);
    const blocks: number[] = [];
    for (let i = 0; i < 20; i++) blocks.push(bm.alloc()); // 1..20
    bm.free(5);
    bm.free(12);
    // next alloc should reuse the lowest freed block (hint moved to 5)
    expect(bm.alloc()).toBe(5);
    expect(bm.alloc()).toBe(12);
  });
});

describe('Bitmap.allocRun (PERF-6 contiguous runs)', () => {
  it('allocates a contiguous run and marks every block', () => {
    const bm = new Bitmap(128);
    const first = bm.allocRun(5);
    expect(first).toBe(1);
    // The run [1,6) is now taken; the next single alloc is 6.
    expect(bm.alloc()).toBe(6);
  });

  it('finds a run spanning a word boundary', () => {
    const bm = new Bitmap(128);
    // Allocate blocks 1..30 individually, leaving 31 free then 32.. free.
    for (let i = 0; i < 30; i++) bm.alloc(); // 1..30
    // Free a hole that is too small, then request a run of 4 — it must skip the
    // 1-block hole at 31 alone is fine actually; request 4 forces crossing 31->34.
    const first = bm.allocRun(4); // should be 31,32,33,34 (spans word 0/1 boundary)
    expect(first).toBe(31);
    expect(bm.alloc()).toBe(35);
  });

  it('returns -1 when no contiguous run of the requested size fits', () => {
    const bm = new Bitmap(64);
    // Occupy blocks so that only isolated single holes remain.
    for (let i = 1; i < 64; i++) bm.alloc(); // fill 1..63
    bm.free(10);
    bm.free(20);
    bm.free(30);
    // Single holes exist but no run of 2 is contiguous.
    expect(bm.allocRun(2)).toBe(-1);
    // A run of 1 still works (delegates to alloc) — lowest freed first.
    expect(bm.allocRun(1)).toBe(10);
  });

  it('free then allocRun reuses a contiguous freed span', () => {
    const bm = new Bitmap(128);
    for (let i = 0; i < 20; i++) bm.alloc(); // 1..20
    // Free a contiguous span [8,12).
    for (let b = 8; b < 12; b++) bm.free(b);
    const first = bm.allocRun(4);
    expect(first).toBe(8);
    // The span is fully reclaimed.
    expect(bm.alloc()).toBe(21);
  });

  it('grows and allocates into the new space', () => {
    const bm = new Bitmap(32); // one word
    for (let i = 1; i < 32; i++) bm.alloc(); // fill 1..31
    expect(bm.alloc()).toBe(-1);
    bm.grow(64);
    expect(bm.getTotalBlocks()).toBe(64);
    expect(bm.alloc()).toBe(32);
  });
});
