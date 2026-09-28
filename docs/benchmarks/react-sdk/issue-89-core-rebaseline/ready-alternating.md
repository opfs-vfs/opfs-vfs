# Alternating leader/disk ready check

On 2026-09-28, the P0 driver-only commit `ef42646` and current public candidate `4f6fbdb` ran in alternating order on the same machine and Chromium 147.0.7727.15. Both used the same harness bytes. Each round measured five fresh runs of 20 cold leader/disk ready cycles, with two warmups; the warm read case had one measured operation. This targeted configuration is not gate-eligible and does not replace the full-matrix comparison. All six raw `samples.json` outputs, including source, fixture hashes and configuration, are in [ready-alternating-samples.json.gz](ready-alternating-samples.json.gz).

| Pair, order | P0 ready median | Current ready median | Delta | Ratio |
| --- | ---: | ---: | ---: | ---: |
| A, P0 → current | 13.225 ms | 14.190 ms | +0.965 ms | 1.073× |
| B, P0 → current | 13.580 ms | 14.355 ms | +0.775 ms | 1.057× |
| C, current → P0 | 13.565 ms | 14.210 ms | +0.645 ms | 1.048× |

Every current per-run ready median exceeded every P0 per-run median within its pair. Pairs A and B exceed the 5% median budget and 0.05 ms cold floor; pair C falls just under 5%. The paired p95 ratios were below the 10% tail budget. The full-matrix leader/disk ready regression remains open. The gap appears real, but these measurements do not isolate its exact contributor or justify changing the raw-worker initialization protocol.
