# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.100 (regressed) | 1.086 (pass) | - | regressed |
| follower/disk/ready | 1.085 (regressed) | 1.028 (pass) | - | regressed |
| follower/memory/close | 1.103 (regressed) | 1.125 (regressed) | - | regressed |
| follower/memory/ready | 1.053 (inconclusive) | 1.048 (pass) | - | inconclusive |
| leader/disk/close | 0.974 (pass) | 0.981 (pass) | - | pass |
| leader/disk/ready | 1.047 (pass) | 1.040 (pass) | - | pass |
| leader/memory/close | 0.967 (pass) | 0.954 (pass) | - | pass |
| leader/memory/ready | 1.031 (pass) | 1.033 (pass) | - | pass |
| sab/disk/close | 0.971 (pass) | 0.972 (pass) | - | pass |
| sab/disk/ready | 1.051 (regressed) | 1.052 (pass) | - | regressed |
| sab/memory/close | 0.961 (pass) | 0.971 (pass) | - | pass |
| sab/memory/ready | 1.044 (pass) | 1.036 (pass) | - | pass |
| follower/disk/large-read | 1.000 (pass) | 1.002 (pass) | 0.998 (pass) | pass |
| follower/disk/large-write | 0.989 (pass) | 0.970 (pass) | 1.009 (pass) | pass |
| follower/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.004 (pass) | pass |
| follower/disk/read | 1.000 (pass) | 1.000 (pass) | 0.998 (pass) | pass |
| follower/disk/sync | 1.021 (pass) | 1.020 (pass) | 0.983 (pass) | pass |
| follower/disk/write | 1.000 (pass) | 0.976 (pass) | 1.000 (pass) | pass |
| follower/memory/large-read | 0.994 (pass) | 0.982 (pass) | 1.005 (pass) | pass |
| follower/memory/large-write | 0.994 (pass) | 0.995 (pass) | 1.002 (pass) | pass |
| follower/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.009 (pass) | pass |
| follower/memory/read | 1.000 (pass) | 1.056 (pass) | 0.994 (pass) | pass |
| follower/memory/sync | 1.012 (pass) | 1.011 (pass) | 0.988 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 1.000 (pass) | 0.991 (pass) | pass |
| leader/disk/large-read | 0.998 (pass) | 1.000 (pass) | 1.004 (pass) | pass |
| leader/disk/large-write | 1.000 (pass) | 0.992 (pass) | 1.010 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.023 (pass) | pass |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 0.998 (pass) | pass |
| leader/disk/sync | 1.000 (pass) | 1.000 (pass) | 0.993 (pass) | pass |
| leader/disk/write | 1.000 (pass) | 1.000 (pass) | 1.000 (pass) | pass |
| leader/memory/large-read | 1.000 (pass) | 2.727 (inconclusive) | 0.940 (inconclusive) | inconclusive |
| leader/memory/large-write | 1.004 (pass) | 1.022 (pass) | 0.994 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 1.000 (pass) | 0.984 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 1.000 (pass) | 1.141 (pass) | pass |
| leader/memory/sync | 1.014 (pass) | 1.000 (pass) | 0.992 (pass) | pass |
| leader/memory/write | 1.038 (pass) | 1.034 (pass) | 0.988 (pass) | pass |
| sab/disk/large-read | 0.997 (pass) | 0.985 (pass) | 1.010 (pass) | pass |
| sab/disk/large-write | 1.000 (pass) | 0.928 (pass) | 1.004 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
| sab/disk/read | 1.000 (pass) | 1.000 (pass) | 0.993 (pass) | pass |
| sab/disk/sync | 1.000 (pass) | 1.000 (pass) | 0.991 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.000 (pass) | 0.999 (pass) | pass |
| sab/memory/large-read | 1.000 (pass) | 1.000 (pass) | 0.992 (pass) | pass |
| sab/memory/large-write | 1.000 (pass) | 1.032 (pass) | 1.004 (pass) | pass |
| sab/memory/metadata | 0.667 (pass) | 1.000 (pass) | 1.017 (pass) | pass |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 0.924 (inconclusive) | inconclusive |
| sab/memory/sync | 1.000 (pass) | 1.000 (pass) | 0.995 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 0.997 (pass) | pass |
