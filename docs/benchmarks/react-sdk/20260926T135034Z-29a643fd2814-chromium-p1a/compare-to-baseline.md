# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.000 (pass) | 0.972 (pass) | - | pass |
| follower/disk/ready | 0.984 (pass) | 1.014 (pass) | - | pass |
| follower/memory/close | 1.000 (pass) | 0.939 (pass) | - | pass |
| follower/memory/ready | 1.000 (pass) | 1.032 (pass) | - | pass |
| leader/disk/close | 1.000 (pass) | 0.985 (pass) | - | pass |
| leader/disk/ready | 1.036 (pass) | 1.064 (pass) | - | pass |
| leader/memory/close | 0.997 (pass) | 0.977 (pass) | - | pass |
| leader/memory/ready | 1.008 (pass) | 1.004 (pass) | - | pass |
| sab/disk/close | 0.984 (pass) | 0.981 (pass) | - | pass |
| sab/disk/ready | 1.032 (pass) | 1.010 (pass) | - | pass |
| sab/memory/close | 0.991 (pass) | 0.988 (pass) | - | pass |
| sab/memory/ready | 1.012 (pass) | 1.010 (pass) | - | pass |
| follower/disk/large-read | 0.986 (pass) | 0.990 (pass) | 1.013 (pass) | pass |
| follower/disk/large-write | 0.968 (pass) | 0.892 (pass) | 1.040 (pass) | pass |
| follower/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.010 (pass) | pass |
| follower/disk/read | 1.000 (pass) | 1.000 (pass) | 1.003 (pass) | pass |
| follower/disk/sync | 1.000 (pass) | 1.000 (pass) | 1.005 (pass) | pass |
| follower/disk/write | 1.000 (pass) | 0.976 (pass) | 1.009 (pass) | pass |
| follower/memory/large-read | 0.976 (pass) | 1.009 (pass) | 1.036 (pass) | pass |
| follower/memory/large-write | 0.976 (pass) | 0.959 (pass) | 1.025 (pass) | pass |
| follower/memory/metadata | 1.000 (pass) | 0.944 (pass) | 1.024 (pass) | pass |
| follower/memory/read | 1.000 (pass) | 1.056 (pass) | 0.999 (pass) | pass |
| follower/memory/sync | 1.000 (pass) | 0.989 (pass) | 1.010 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 0.978 (pass) | 1.014 (pass) | pass |
| leader/disk/large-read | 0.996 (pass) | 1.021 (pass) | 1.003 (pass) | pass |
| leader/disk/large-write | 1.008 (pass) | 0.992 (pass) | 1.009 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 0.750 (inconclusive) | 1.002 (pass) | inconclusive |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 0.997 (pass) | pass |
| leader/disk/sync | 1.000 (pass) | 1.000 (pass) | 1.003 (pass) | pass |
| leader/disk/write | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
| leader/memory/large-read | 0.889 (pass) | 0.435 (inconclusive) | 1.065 (pass) | inconclusive |
| leader/memory/large-write | 0.988 (pass) | 0.888 (pass) | 1.025 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 0.750 (pass) | 1.004 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 0.750 (pass) | 1.041 (pass) | pass |
| leader/memory/sync | 1.000 (pass) | 1.000 (pass) | 1.000 (pass) | pass |
| leader/memory/write | 1.000 (pass) | 1.034 (pass) | 0.998 (pass) | pass |
| sab/disk/large-read | 0.993 (pass) | 0.992 (pass) | 1.006 (pass) | pass |
| sab/disk/large-write | 0.995 (pass) | 1.000 (pass) | 1.013 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.010 (pass) | pass |
| sab/disk/read | 1.000 (pass) | 1.000 (pass) | 1.010 (pass) | pass |
| sab/disk/sync | 1.000 (pass) | 0.974 (pass) | 1.010 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.000 (pass) | 1.004 (pass) | pass |
| sab/memory/large-read | 0.968 (pass) | 0.977 (pass) | 1.026 (pass) | pass |
| sab/memory/large-write | 0.989 (pass) | 0.971 (pass) | 1.018 (pass) | pass |
| sab/memory/metadata | 1.500 (inconclusive) | 1.000 (pass) | 0.979 (pass) | inconclusive |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 0.980 (pass) | pass |
| sab/memory/sync | 0.986 (pass) | 1.000 (pass) | 1.009 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 1.014 (pass) | pass |
