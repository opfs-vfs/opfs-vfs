# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.000 (pass) | 0.972 (pass) | - | pass |
| follower/disk/ready | 0.951 (pass) | 1.000 (pass) | - | pass |
| follower/memory/close | 1.034 (pass) | 0.970 (pass) | - | pass |
| follower/memory/ready | 1.000 (pass) | 1.048 (pass) | - | pass |
| leader/disk/close | 0.994 (pass) | 0.988 (pass) | - | pass |
| leader/disk/ready | 1.003 (pass) | 0.996 (pass) | - | pass |
| leader/memory/close | 1.003 (pass) | 1.003 (pass) | - | pass |
| leader/memory/ready | 0.998 (pass) | 0.997 (pass) | - | pass |
| sab/disk/close | 0.994 (pass) | 0.997 (pass) | - | pass |
| sab/disk/ready | 1.000 (pass) | 0.995 (pass) | - | pass |
| sab/memory/close | 1.000 (pass) | 1.012 (pass) | - | pass |
| sab/memory/ready | 1.002 (pass) | 1.011 (pass) | - | pass |
| follower/disk/large-read | 0.992 (pass) | 0.984 (pass) | 1.009 (pass) | pass |
| follower/disk/large-write | 0.986 (pass) | 0.927 (pass) | 1.012 (pass) | pass |
| follower/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.005 (pass) | pass |
| follower/disk/read | 1.000 (pass) | 1.000 (pass) | 0.997 (pass) | pass |
| follower/disk/sync | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
| follower/disk/write | 1.000 (pass) | 0.976 (pass) | 1.009 (pass) | pass |
| follower/memory/large-read | 1.000 (pass) | 1.042 (pass) | 1.004 (pass) | pass |
| follower/memory/large-write | 0.994 (pass) | 1.000 (pass) | 1.003 (pass) | pass |
| follower/memory/metadata | 1.000 (pass) | 0.944 (pass) | 1.009 (pass) | pass |
| follower/memory/read | 1.000 (pass) | 1.056 (pass) | 0.987 (pass) | pass |
| follower/memory/sync | 1.012 (pass) | 0.989 (pass) | 1.002 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 0.978 (pass) | 1.011 (pass) | pass |
| leader/disk/large-read | 0.991 (pass) | 1.002 (pass) | 1.005 (pass) | pass |
| leader/disk/large-write | 1.000 (pass) | 0.985 (pass) | 1.018 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 1.000 (pass) | 0.979 (pass) | pass |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 0.999 (pass) | pass |
| leader/disk/sync | 1.000 (pass) | 1.000 (pass) | 1.007 (pass) | pass |
| leader/disk/write | 1.000 (pass) | 1.040 (pass) | 0.997 (pass) | pass |
| leader/memory/large-read | 1.000 (pass) | 0.478 (inconclusive) | 1.043 (pass) | inconclusive |
| leader/memory/large-write | 1.001 (pass) | 1.008 (pass) | 1.000 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 0.750 (pass) | 1.035 (pass) | pass |
| leader/memory/sync | 0.986 (pass) | 1.000 (pass) | 1.000 (pass) | pass |
| leader/memory/write | 0.963 (pass) | 1.000 (pass) | 1.010 (pass) | pass |
| sab/disk/large-read | 0.991 (pass) | 0.990 (pass) | 1.008 (pass) | pass |
| sab/disk/large-write | 1.005 (pass) | 1.063 (pass) | 0.995 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.020 (pass) | pass |
| sab/disk/read | 1.000 (pass) | 1.000 (pass) | 1.009 (pass) | pass |
| sab/disk/sync | 1.000 (pass) | 1.000 (pass) | 1.008 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.000 (pass) | 1.001 (pass) | pass |
| sab/memory/large-read | 1.008 (pass) | 1.008 (pass) | 0.991 (pass) | pass |
| sab/memory/large-write | 1.001 (pass) | 0.975 (inconclusive) | 1.001 (pass) | inconclusive |
| sab/memory/metadata | 1.500 (inconclusive) | 1.000 (pass) | 0.984 (pass) | inconclusive |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 0.976 (pass) | pass |
| sab/memory/sync | 0.986 (pass) | 1.000 (pass) | 1.006 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 1.007 (pass) | pass |
