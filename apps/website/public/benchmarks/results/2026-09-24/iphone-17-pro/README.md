# iPhone SQL benchmark, 24 September 2026

Original standalone runner export provided by the device owner. SHA-256: `984691f81e517af5f7b1d8d9b5dd3133c634c1fd2b9d8831d40dff7749c00827`.

Device note: iPhone 17 Pro, iOS 26.6.1, carried over from the previous run at the owner's explicit request. The replacement export has an empty environmentNote and is preserved unchanged. Safari reports version 26.6.1.
OPFS VFS 1.0.1, PGlite 0.5.4; exact source commit unavailable.
Three repetitions per backend, 16-case SQL workload revision pglite-speedtest16-ae182ff8-v1.
Disk buffering, balanced VFS durability, PGlite relaxedDurability=false.
The export contains no excluded full-workload warm-up sample. Preparation time is recorded separately.
Power mode, extensions, thermal state and other collection conditions were not recorded.

Only status=ok samples contribute to displayed medians and observed ranges.
All twelve samples passed: three each for VFS, AHP, IndexedDB and memory, with 16 stages and matching row checks.
This export replaces the previous iPhone collection, whose IndexedDB cleanup failed. The new IndexedDB samples passed cleanup and are included.
Memory is nonpersistent. The SQL suite drops its tables; its reopen check does not demonstrate retained-data durability.
This standalone run appears alongside the five-round Mac collections, with different repetition counts and warm-up protocols stated explicitly.
AHP success here does not establish support on every Safari version or workload.

## Additional runs

Device details carry over from the same iPhone at the owner's request; all original exports remain unchanged. All 42 additional samples passed.

- `transactions-disk.json`: 10,000-row transactions, disk-buffered VFS plus AHP, IndexedDB and memory; three runs each. All persistent runs verified 10,000 rows after reopening.
- `sql-memory.json`: 16-case SQL suite with VFS memory buffering; three runs per backend. The shared table uses only the VFS memory-buffer samples from this file. AHP, IndexedDB and memory-only SQL values continue to use `safari.json`; their repeated samples here are retained but not pooled or selected by speed.
- `filesystem-disk.json` and `filesystem-memory.json`: 100 files, 1 KiB each, three runs per buffer mode. Each run verified 50 surviving files. These differ from the Macs' 1,000-file workload and appear in a separately labelled detail table.

The six iPhone exports contain 54 raw samples; 36 contribute to displayed summaries and 18 are repeated SQL/transaction reference-backend samples retained only in the raw exports.

`transactions-memory.json` supplies the VFS memory-buffer transaction result: three successful runs with 10,000 retained rows each. Its repeated AHP, IndexedDB and memory-only samples are preserved but not pooled with or substituted for the original transaction collection. All 12 samples in this export passed.

Additional SHA-256 checksums:

- `transactions-disk.json`: `a9dbcdc42b5ef189f0197db26abe9cfeae04506e7f29b9c65e3ed76dbadadb81`
- `sql-memory.json`: `12f7127da1adb32128a6a7541a30d24b2dc180bb603716e66ff5b11bc1649213`
- `filesystem-disk.json`: `1e35f190a12058d5fee2d5c753bdd3b70c661d7f7430f10907b6a1feca3663fc`
- `filesystem-memory.json`: `88821b1e5f495259d22bcf7f55a3b305c6a64b0c27f430dfc20425e45b427c1a`

- `transactions-memory.json`: `b259d79fc1ce1732b07930956bf600446ec64b5a2fcfbf79c6bec6b6532c2e83`
