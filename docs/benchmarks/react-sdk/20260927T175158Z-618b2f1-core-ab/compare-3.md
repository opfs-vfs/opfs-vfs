# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.100 (regressed) | 1.176 (regressed) | - | regressed |
| follower/disk/ready | 1.050 (pass) | 1.071 (pass) | - | pass |
| follower/memory/close | 1.069 (regressed) | 1.094 (pass) | - | regressed |
| follower/memory/ready | 1.034 (pass) | 0.985 (pass) | - | pass |
| leader/disk/close | 0.981 (pass) | 0.981 (pass) | - | pass |
| leader/disk/ready | 1.056 (regressed) | 1.055 (pass) | - | regressed |
| leader/memory/close | 0.962 (pass) | 0.983 (pass) | - | pass |
| leader/memory/ready | 1.038 (pass) | 1.034 (pass) | - | pass |
| sab/disk/close | 0.984 (pass) | 0.994 (pass) | - | pass |
| sab/disk/ready | 1.056 (inconclusive) | 1.052 (pass) | - | inconclusive |
| sab/memory/close | 0.961 (pass) | 0.983 (pass) | - | pass |
| sab/memory/ready | 1.036 (pass) | 1.030 (pass) | - | pass |
| follower/disk/large-read | 0.994 (pass) | 1.008 (pass) | 1.005 (pass) | pass |
| follower/disk/large-write | 1.004 (pass) | 1.000 (pass) | 0.997 (pass) | pass |
| follower/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.000 (pass) | pass |
| follower/disk/read | 1.000 (pass) | 1.000 (pass) | 0.993 (pass) | pass |
| follower/disk/sync | 1.021 (pass) | 1.020 (pass) | 0.981 (pass) | pass |
| follower/disk/write | 1.000 (pass) | 1.000 (pass) | 0.993 (pass) | pass |
| follower/memory/large-read | 1.012 (pass) | 0.995 (pass) | 0.996 (pass) | pass |
| follower/memory/large-write | 0.998 (pass) | 0.996 (pass) | 1.002 (pass) | pass |
| follower/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.022 (pass) | pass |
| follower/memory/read | 1.067 (inconclusive) | 1.000 (pass) | 0.990 (pass) | inconclusive |
| follower/memory/sync | 1.012 (pass) | 1.011 (pass) | 0.988 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 1.000 (pass) | 0.989 (pass) | pass |
| leader/disk/large-read | 0.994 (pass) | 1.004 (pass) | 1.005 (pass) | pass |
| leader/disk/large-write | 1.025 (pass) | 1.016 (pass) | 0.978 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 1.000 (pass) | 0.894 (inconclusive) | inconclusive |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 0.988 (pass) | pass |
| leader/disk/sync | 1.000 (pass) | 1.027 (pass) | 0.994 (pass) | pass |
| leader/disk/write | 1.000 (pass) | 1.000 (pass) | 0.995 (pass) | pass |
| leader/memory/large-read | 1.000 (pass) | 3.263 (regressed) | 0.958 (pass) | regressed |
| leader/memory/large-write | 1.001 (pass) | 1.020 (pass) | 0.993 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.021 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 0.750 (pass) | 0.947 (inconclusive) | inconclusive |
| leader/memory/sync | 1.000 (pass) | 1.000 (pass) | 0.995 (pass) | pass |
| leader/memory/write | 1.000 (pass) | 1.000 (pass) | 1.000 (pass) | pass |
| sab/disk/large-read | 0.993 (pass) | 0.995 (pass) | 1.010 (pass) | pass |
| sab/disk/large-write | 1.000 (pass) | 0.986 (pass) | 0.997 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.015 (pass) | pass |
| sab/disk/read | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
| sab/disk/sync | 1.000 (pass) | 1.000 (pass) | 0.989 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.000 (pass) | 0.994 (pass) | pass |
| sab/memory/large-read | 1.016 (pass) | 1.024 (pass) | 0.979 (pass) | pass |
| sab/memory/large-write | 0.995 (pass) | 0.981 (pass) | 1.005 (pass) | pass |
| sab/memory/metadata | 1.000 (pass) | 1.000 (pass) | 0.965 (pass) | pass |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 0.972 (pass) | pass |
| sab/memory/sync | 1.014 (pass) | 1.000 (pass) | 0.994 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 0.995 (pass) | pass |
