# Three-tab follower relay probe

Run from the repository root with `node docs/benchmarks/react-sdk/issue-89-relay-probe/probe.mjs`. The probe opens a memory-mode owner and two followers in separate Chromium tabs, writes a 16 MiB file, then has one follower read it 12 times while the third tab stays idle. It records the idle tab's BroadcastChannel replies, long tasks, and CDP heap before and after the reads. The script and all three raw runs are saved here.

All three runs used Chromium 147.0.7727.15 on 2026-09-28. The idle follower received all 12 large replies in every run. It reported zero tasks over 50 ms, versus zero during the preceding idle interval. Its `Runtime.getHeapUsage().backingStorageSize` was 32 MiB higher after the reads in every run. This is a retained end-point measurement, not a peak or a precise accounting of every structured clone. The reader's 12 calls took 14 to 19 ms each.

The fan-out is real, but these runs do not show an idle-tab long-task problem. The data does not justify changing the relay protocol yet. A longer run or more tabs should precede any per-follower channel design.
