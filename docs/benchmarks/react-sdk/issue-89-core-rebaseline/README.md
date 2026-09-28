# Core rebaseline for issue #89

On 2026-09-28, the core benchmark ran with `--large-ops 256` (the new default), five runs, and all warm and cold cases. P0 was original commit `48f0d2c` plus only the updated benchmark driver, committed locally as `ef42646`. The current stack was measured at clean commit `0a3aadb`. Both runs used the same driver and fixture hashes, Chromium version, machine, and configuration. Both are gate-eligible. The raw samples and summaries are saved here; `comparison.md` is the driver's full output.

| Case | P0 | Current | Result |
| --- | ---: | ---: | --- |
| Leader/memory 1 MiB read p95 | 0.125 ms | 0.135 ms | Pass; stable over five runs on both sides |
| Follower/disk close median | 0.155 ms | 0.175 ms | Pass under the 0.05 ms cold-case floor |
| Follower/memory close median | 0.145 ms | 0.165 ms | Pass under the same floor |
| Leader/disk ready median | 13.155 ms | 14.310 ms | Regressed |

The comparison has 41 passes, 6 inconclusive cases, and 1 regression. The ready regression remains open. A subsequent [alternating leader/disk ready check](ready-alternating.md) found a 0.645–0.965 ms current-over-P0 median gap in three pairs, with two pairs over the 5% budget. The proposed `INIT` persistence-frame shortcut was not applied because the raw-worker protocol requires a versioned `PERSISTENCE_STATUS` request before frames begin. Neither the full-matrix comparison nor the targeted check waives the earlier recorded exceptions.
