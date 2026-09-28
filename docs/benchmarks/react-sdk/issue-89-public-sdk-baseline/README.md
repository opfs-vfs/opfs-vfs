# Public React SDK baseline after issue #89

Run on 2026-09-28 from clean commit `a5e4243` with Chromium and five measured runs:

```sh
pnpm --filter @opfs-vfs/react benchmark:sdk --out docs/benchmarks/react-sdk/issue-89-public-sdk-baseline
```

The fixture skips binary payloads in `messageCommands()` and checks that the counter still skips them before a run. React compares equal byte content word by word. `environment.json` records the browser, machine, dependency and fixture hashes. `samples.json.gz` contains all raw results.

| Case | Direct unchanged read median | SDK unchanged refresh median | Long tasks across five runs |
| --- | ---: | ---: | ---: |
| 1 MiB | 0.125 ms | 0.645 ms | 0 |
| 16 MiB | 1.08 ms | 3.035 ms | 0 |

The earlier `a5f3778` results used a different fixture and are not a comparable baseline. This run covers the public SDK only.
