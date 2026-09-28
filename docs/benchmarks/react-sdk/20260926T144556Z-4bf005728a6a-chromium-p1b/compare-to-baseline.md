# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.033 (pass) | 1.000 (pass) | - | pass |
| follower/disk/ready | 0.951 (pass) | 0.986 (pass) | - | pass |
| follower/memory/close | 1.034 (pass) | 1.030 (pass) | - | pass |
| follower/memory/ready | 0.983 (pass) | 1.016 (pass) | - | pass |
| leader/disk/close | 0.997 (pass) | 0.981 (pass) | - | pass |
| leader/disk/ready | 1.020 (pass) | 1.021 (pass) | - | pass |
| leader/memory/close | 0.994 (pass) | 0.977 (pass) | - | pass |
| leader/memory/ready | 1.002 (pass) | 0.997 (pass) | - | pass |
| sab/disk/close | 0.987 (pass) | 0.984 (pass) | - | pass |
| sab/disk/ready | 1.025 (pass) | 1.010 (pass) | - | pass |
| sab/memory/close | 0.997 (pass) | 0.997 (pass) | - | pass |
| sab/memory/ready | 1.010 (pass) | 1.020 (pass) | - | pass |
| follower/disk/large-read | 0.982 (pass) | 0.958 (pass) | 1.018 (pass) | pass |
| follower/disk/large-write | 0.971 (pass) | 0.905 (pass) | 1.039 (pass) | pass |
| follower/disk/metadata | 0.938 (pass) | 1.000 (pass) | 1.018 (pass) | pass |
| follower/disk/read | 1.000 (pass) | 1.000 (pass) | 1.005 (pass) | pass |
| follower/disk/sync | 1.000 (pass) | 1.000 (pass) | 1.009 (pass) | pass |
| follower/disk/write | 1.000 (pass) | 0.976 (pass) | 1.016 (pass) | pass |
| follower/memory/large-read | 0.976 (pass) | 0.977 (pass) | 1.030 (pass) | pass |
| follower/memory/large-write | 0.971 (pass) | 0.962 (pass) | 1.028 (pass) | pass |
| follower/memory/metadata | 1.000 (pass) | 0.944 (pass) | 1.021 (pass) | pass |
| follower/memory/read | 1.000 (pass) | 1.000 (pass) | 1.006 (pass) | pass |
| follower/memory/sync | 0.988 (pass) | 0.978 (pass) | 1.013 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 0.978 (pass) | 1.007 (pass) | pass |
| leader/disk/large-read | 0.987 (pass) | 0.988 (pass) | 1.007 (pass) | pass |
| leader/disk/large-write | 1.000 (pass) | 0.970 (pass) | 1.016 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 0.750 (pass) | 1.013 (pass) | pass |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 1.004 (pass) | pass |
| leader/disk/sync | 1.000 (pass) | 0.974 (pass) | 1.017 (pass) | pass |
| leader/disk/write | 1.000 (pass) | 1.000 (pass) | 1.006 (pass) | pass |
| leader/memory/large-read | 0.889 (pass) | 0.413 (inconclusive) | 1.098 (pass) | inconclusive |
| leader/memory/large-write | 0.980 (pass) | 0.881 (pass) | 1.033 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 0.750 (pass) | 1.002 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 0.750 (pass) | 1.042 (pass) | pass |
| leader/memory/sync | 0.986 (pass) | 1.000 (pass) | 1.002 (pass) | pass |
| leader/memory/write | 0.963 (pass) | 1.000 (pass) | 1.008 (pass) | pass |
| sab/disk/large-read | 0.991 (pass) | 0.982 (pass) | 1.012 (pass) | pass |
| sab/disk/large-write | 0.995 (pass) | 0.995 (pass) | 1.013 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 1.011 (pass) | pass |
| sab/disk/read | 1.000 (pass) | 1.000 (pass) | 1.015 (pass) | pass |
| sab/disk/sync | 1.000 (pass) | 0.974 (pass) | 1.014 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.000 (pass) | 1.012 (pass) | pass |
| sab/memory/large-read | 0.976 (pass) | 0.977 (pass) | 1.014 (pass) | pass |
| sab/memory/large-write | 0.982 (pass) | 0.969 (pass) | 1.022 (pass) | pass |
| sab/memory/metadata | 1.500 (inconclusive) | 1.000 (pass) | 0.960 (pass) | inconclusive |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 1.014 (pass) | pass |
| sab/memory/sync | 0.986 (pass) | 0.987 (pass) | 1.011 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 1.026 (pass) | pass |
