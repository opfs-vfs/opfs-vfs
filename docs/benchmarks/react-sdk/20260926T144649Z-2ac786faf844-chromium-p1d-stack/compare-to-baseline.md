# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.033 (pass) | 1.000 (pass) | - | pass |
| follower/disk/ready | 0.967 (pass) | 0.986 (pass) | - | pass |
| follower/memory/close | 1.034 (pass) | 1.030 (pass) | - | pass |
| follower/memory/ready | 1.000 (pass) | 1.048 (pass) | - | pass |
| leader/disk/close | 1.000 (pass) | 0.985 (pass) | - | pass |
| leader/disk/ready | 1.038 (pass) | 1.032 (pass) | - | pass |
| leader/memory/close | 1.003 (pass) | 0.983 (pass) | - | pass |
| leader/memory/ready | 1.008 (pass) | 0.998 (pass) | - | pass |
| sab/disk/close | 0.990 (pass) | 0.984 (pass) | - | pass |
| sab/disk/ready | 1.036 (pass) | 1.010 (pass) | - | pass |
| sab/memory/close | 0.994 (pass) | 1.009 (pass) | - | pass |
| sab/memory/ready | 1.018 (pass) | 1.019 (pass) | - | pass |
| follower/disk/large-read | 0.989 (pass) | 0.972 (pass) | 1.012 (pass) | pass |
| follower/disk/large-write | 0.968 (pass) | 0.902 (pass) | 1.043 (pass) | pass |
| follower/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.005 (pass) | pass |
| follower/disk/read | 1.000 (pass) | 1.000 (pass) | 1.007 (pass) | pass |
| follower/disk/sync | 1.000 (pass) | 1.000 (pass) | 1.003 (pass) | pass |
| follower/disk/write | 1.000 (pass) | 0.976 (pass) | 1.014 (pass) | pass |
| follower/memory/large-read | 0.970 (pass) | 0.977 (pass) | 1.047 (pass) | pass |
| follower/memory/large-write | 0.975 (pass) | 0.946 (pass) | 1.023 (pass) | pass |
| follower/memory/metadata | 1.000 (pass) | 0.944 (pass) | 1.028 (pass) | pass |
| follower/memory/read | 0.938 (pass) | 1.000 (pass) | 1.010 (pass) | pass |
| follower/memory/sync | 1.000 (pass) | 0.989 (pass) | 1.012 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 0.978 (pass) | 1.013 (pass) | pass |
| leader/disk/large-read | 0.998 (pass) | 0.994 (pass) | 0.998 (pass) | pass |
| leader/disk/large-write | 0.984 (pass) | 0.962 (pass) | 1.034 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 0.750 (pass) | 1.011 (pass) | pass |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 1.004 (pass) | pass |
| leader/disk/sync | 1.000 (pass) | 0.974 (pass) | 1.010 (pass) | pass |
| leader/disk/write | 1.000 (pass) | 1.000 (pass) | 1.008 (pass) | pass |
| leader/memory/large-read | 0.944 (pass) | 0.435 (inconclusive) | 1.075 (pass) | inconclusive |
| leader/memory/large-write | 0.987 (pass) | 0.879 (pass) | 1.026 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 0.750 (pass) | 1.008 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 0.750 (pass) | 1.054 (pass) | pass |
| leader/memory/sync | 1.000 (pass) | 1.000 (pass) | 0.997 (pass) | pass |
| leader/memory/write | 1.000 (pass) | 1.000 (pass) | 1.002 (pass) | pass |
| sab/disk/large-read | 0.995 (pass) | 0.990 (pass) | 1.005 (pass) | pass |
| sab/disk/large-write | 0.995 (pass) | 0.986 (pass) | 1.012 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.005 (pass) | pass |
| sab/disk/read | 1.000 (pass) | 1.000 (pass) | 1.002 (pass) | pass |
| sab/disk/sync | 1.000 (pass) | 0.974 (pass) | 1.004 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.000 (pass) | 1.002 (pass) | pass |
| sab/memory/large-read | 0.968 (pass) | 0.969 (pass) | 1.030 (pass) | pass |
| sab/memory/large-write | 0.982 (pass) | 0.934 (pass) | 1.025 (pass) | pass |
| sab/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.005 (pass) | pass |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 0.988 (pass) | pass |
| sab/memory/sync | 0.986 (pass) | 0.987 (pass) | 1.007 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 1.007 (pass) | pass |
