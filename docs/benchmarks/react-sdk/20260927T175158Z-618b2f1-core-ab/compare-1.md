# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.100 (inconclusive) | 1.114 (regressed) | - | regressed |
| follower/disk/ready | 1.050 (pass) | 1.070 (pass) | - | pass |
| follower/memory/close | 1.033 (pass) | 1.000 (pass) | - | pass |
| follower/memory/ready | 1.034 (pass) | 1.016 (pass) | - | pass |
| leader/disk/close | 0.981 (pass) | 0.997 (pass) | - | pass |
| leader/disk/ready | 1.066 (inconclusive) | 1.088 (pass) | - | inconclusive |
| leader/memory/close | 0.973 (pass) | 0.983 (pass) | - | pass |
| leader/memory/ready | 1.045 (pass) | 1.042 (pass) | - | pass |
| sab/disk/close | 0.971 (pass) | 0.938 (pass) | - | pass |
| sab/disk/ready | 1.061 (regressed) | 1.036 (pass) | - | regressed |
| sab/memory/close | 0.982 (pass) | 0.971 (pass) | - | pass |
| sab/memory/ready | 1.047 (pass) | 1.043 (pass) | - | pass |
| follower/disk/large-read | 1.003 (pass) | 0.967 (pass) | 1.011 (pass) | pass |
| follower/disk/large-write | 1.015 (pass) | 1.084 (pass) | 0.981 (pass) | pass |
| follower/disk/metadata | 1.067 (inconclusive) | 1.000 (pass) | 0.995 (pass) | inconclusive |
| follower/disk/read | 1.000 (pass) | 1.030 (pass) | 0.987 (pass) | pass |
| follower/disk/sync | 1.021 (pass) | 1.020 (pass) | 0.974 (pass) | pass |
| follower/disk/write | 1.000 (pass) | 1.025 (pass) | 0.996 (pass) | pass |
| follower/memory/large-read | 1.000 (pass) | 1.042 (pass) | 0.995 (pass) | pass |
| follower/memory/large-write | 1.003 (pass) | 1.011 (pass) | 1.005 (pass) | pass |
| follower/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.022 (pass) | pass |
| follower/memory/read | 1.067 (inconclusive) | 1.056 (pass) | 0.985 (pass) | inconclusive |
| follower/memory/sync | 1.012 (pass) | 1.011 (pass) | 0.994 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
| leader/disk/large-read | 1.000 (pass) | 1.010 (pass) | 1.000 (pass) | pass |
| leader/disk/large-write | 1.008 (pass) | 0.992 (pass) | 1.019 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 1.333 (inconclusive) | 0.958 (pass) | inconclusive |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 1.004 (pass) | pass |
| leader/disk/sync | 1.000 (pass) | 1.000 (pass) | 0.991 (pass) | pass |
| leader/disk/write | 1.000 (pass) | 1.000 (pass) | 0.996 (pass) | pass |
| leader/memory/large-read | 1.000 (pass) | 2.700 (inconclusive) | 0.949 (inconclusive) | inconclusive |
| leader/memory/large-write | 1.003 (pass) | 1.030 (pass) | 0.991 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 1.000 (pass) | 0.990 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 1.000 (pass) | 1.137 (pass) | pass |
| leader/memory/sync | 1.014 (pass) | 1.000 (pass) | 0.989 (pass) | pass |
| leader/memory/write | 1.000 (pass) | 1.000 (pass) | 0.995 (pass) | pass |
| sab/disk/large-read | 1.004 (pass) | 1.007 (pass) | 0.992 (pass) | pass |
| sab/disk/large-write | 1.005 (pass) | 0.983 (pass) | 1.012 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.000 (pass) | pass |
| sab/disk/read | 1.000 (pass) | 1.000 (pass) | 0.987 (pass) | pass |
| sab/disk/sync | 1.000 (pass) | 1.027 (pass) | 0.986 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.000 (pass) | 1.008 (pass) | pass |
| sab/memory/large-read | 1.000 (pass) | 1.008 (pass) | 0.991 (pass) | pass |
| sab/memory/large-write | 1.007 (pass) | 1.018 (pass) | 0.997 (pass) | pass |
| sab/memory/metadata | 0.667 (pass) | 1.000 (pass) | 0.996 (pass) | pass |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 0.973 (pass) | pass |
| sab/memory/sync | 1.000 (pass) | 1.013 (pass) | 0.990 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
