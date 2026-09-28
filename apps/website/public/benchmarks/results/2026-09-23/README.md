# Browser storage benchmarks, 23 September 2026

Six collections on two 64 GB Macs: M5 Pro MacBook Pro and M1 Max Mac Studio. The website tables use only the five measured samples per job; the first warm-up is excluded. Every figure is in milliseconds. Ranges are observed minimum–maximum, not confidence intervals.

## Findings

OPFS VFS with disk buffering has the lowest persistent-backend workload median in both SQL workloads in all six machine/browser groups. This is an observation for these workloads and configurations, not a general guarantee.

On the Mac Studio:

| Browser | 16-case SQL suite, VFS disk | Transaction batch, VFS disk | IndexedDB / VFS transaction time |
| ------- | --------------------------: | --------------------------: | -------------------------------: |
| Chrome  |                 3,468.13 ms |                    33.84 ms |                            2.37× |
| Safari  |                 3,329.10 ms |                    27.38 ms |                            6.73× |
| Firefox |                 5,154.52 ms |                    37.52 ms |                            2.90× |

The Firefox SQL-suite comparison with IndexedDB is nearly tied: 5,154.52 ms versus 5,181.70 ms, with overlapping observed ranges. AHP takes 1.08× the VFS disk SQL time in Chrome and 1.45× in Firefox. Safari AHP is omitted by protocol. IndexedDB initialization is faster than VFS disk in Studio Chrome and Firefox. Memory-only PGlite is faster in these workloads but does not persist; OPFS VFS memory buffering does persist and must not be confused with it.

## Method and limits

- 340 measured samples and 68 excluded warm-ups across six complete, uninterrupted collections. Jobs and browser collections ran sequentially. Each sample used a fresh worker and storage name.
- The 16-case SQL suite reports the sum of individual case timings. The 10,000-row transaction batch verifies retained rows after reopening. The SQL suite drops its tables and verifies absence after reopening.
- Filesystem phases use 1,000 files of 1 KiB, delete half and verify the 500 survivors after reopening. Compare the two VFS buffer modes only in this suite.
- Preparation, close and final cleanup are outside workload timing. Initialization and reopen are separate. The subsequent explicit sync is not the total persistence cost: workload time can already contain synchronization.
- VFS uses balanced durability and all PGlite backends use `relaxedDurability: false`. Matching option names do not establish equivalent crash or power-loss guarantees. This collection tests clean reopen only.
- Compare complete systems, not chips alone. The MacBook runs macOS 26.6.2, High Power on AC, with about 556 GiB free. The Studio runs macOS 26.5.2 on AC, with about 58 GiB free; a Low Power Mode field was not exposed. Safari and Chrome versions differ; Firefox is 156.0.1 on both.
- Studio Chrome retained AI-related launch switches. Studio Firefox updated before collection, with the earlier download timing unobserved. Per-browser notes remain in the original JSON; the Studio provenance records these limitations. Other browsers were idle on the MacBook and closed on the Studio.
- These are five repeated observations within one collection per browser, not independent device samples. No mobile measurements are included. Failed or interrupted earlier MacBook attempts are excluded entirely.

### Studio Chrome launch switches

The original collection recorded these existing switches, unchanged during the run:

```text
--enable-features=AIApiFoundationalModel:model_version/v4,AIPromptAPIParams,OnDeviceModelLitertLmBackend,OnDeviceModelSpeculativeDecoding,OptimizationGuideManifestBroker
--origin-trial-disabled-features=CanvasTextNg|WebAssemblyCustomDescriptors
```

## Sources and reproduction

The six original exports under `m5-pro/` and `m1-max/` are preserved byte for byte. Each directory contains its original `provenance.json` with SHA-256 checksums and run intervals. The manifests' `collector.patch` refers to the shared patch in this parent directory.

Measured source: base commit `34ba9b3970c33a57508383778d405f2e1b0d8967` plus `collector.patch`, SHA-256 `985ff0a32a488aaf02083ca4f2c82a53c8ca67ff6f8e9295036d663334c326de`. Exports therefore correctly report a `+dirty` source. The package metadata is OPFS VFS 1.0.1 and PGlite 0.5.4, not a claim that the measured source equals the published 1.0.1 package.

Protocol: `mac-browser-v1`. Workload revisions: `pglite-speedtest16-ae182ff8-v1`, `pglite-sql-v2`, `small-files-v1`. All six exports use identical versions, workload definitions, and matching job configurations for their available backends.

From the repository root, run `python3 scripts/summarize-benchmarks.py` to validate hashes, completion, schedule, settings, correctness, source/workload equality, and non-overlapping intervals, then regenerate `apps/website/src/data/benchmark-results.json`. Python's standard library is sufficient. A companion notebook at `docs/benchmarks/2026-09-23.ipynb` independently recomputes the main comparisons. Website tests independently check every published median and range against the raw files.
