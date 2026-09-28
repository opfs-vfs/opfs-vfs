# Benchmark comparison
gateEligible: baseline=true, candidate=true
harnessSha256 identical: true; config identical: true; browser name+version identical: true
machine os identical: true
| case | median ratio | p95 ratio | throughput ratio | status |
| - | -: | -: | -: | - |
| follower/disk/close | 1.129 (pass) | 1.135 (pass) | - | pass |
| follower/disk/ready | 1.066 (pass) | 1.085 (pass) | - | pass |
| follower/memory/close | 1.138 (pass) | 1.086 (pass) | - | pass |
| follower/memory/ready | 1.033 (pass) | 1.090 (pass) | - | pass |
| leader/disk/close | 1.019 (pass) | 1.053 (pass) | - | pass |
| leader/disk/ready | 1.088 (regressed) | 1.112 (regressed) | - | regressed |
| leader/memory/close | 1.009 (pass) | 0.977 (pass) | - | pass |
| leader/memory/ready | 1.081 (inconclusive) | 1.081 (pass) | - | inconclusive |
| sab/disk/close | 0.972 (pass) | 0.977 (pass) | - | pass |
| sab/disk/ready | 1.066 (inconclusive) | 1.076 (pass) | - | inconclusive |
| sab/memory/close | 0.977 (pass) | 0.984 (pass) | - | pass |
| sab/memory/ready | 1.044 (pass) | 1.041 (pass) | - | pass |
| follower/disk/large-read | 1.018 (pass) | 1.016 (pass) | 0.983 (pass) | pass |
| follower/disk/large-write | 1.004 (pass) | 0.991 (pass) | 0.991 (pass) | pass |
| follower/disk/metadata | 1.000 (pass) | 1.000 (pass) | 0.981 (pass) | pass |
| follower/disk/read | 1.000 (pass) | 1.057 (pass) | 0.982 (pass) | pass |
| follower/disk/sync | 1.042 (pass) | 1.057 (pass) | 0.959 (pass) | pass |
| follower/disk/write | 1.026 (pass) | 1.023 (pass) | 0.978 (pass) | pass |
| follower/memory/large-read | 1.012 (pass) | 1.000 (pass) | 0.986 (pass) | pass |
| follower/memory/large-write | 1.020 (pass) | 1.017 (pass) | 0.981 (pass) | pass |
| follower/memory/metadata | 1.067 (inconclusive) | 1.056 (pass) | 0.990 (pass) | inconclusive |
| follower/memory/read | 1.000 (pass) | 1.000 (pass) | 0.971 (pass) | pass |
| follower/memory/sync | 1.011 (pass) | 1.021 (pass) | 0.982 (pass) | pass |
| follower/memory/write | 1.000 (pass) | 1.021 (pass) | 1.001 (pass) | pass |
| leader/disk/large-read | 1.000 (pass) | 1.016 (pass) | 1.006 (pass) | pass |
| leader/disk/large-write | 1.032 (pass) | 1.088 (pass) | 0.964 (pass) | pass |
| leader/disk/metadata | 1.000 (pass) | 1.000 (pass) | 0.962 (pass) | pass |
| leader/disk/read | 1.000 (pass) | 1.000 (pass) | 0.994 (pass) | pass |
| leader/disk/sync | 1.029 (pass) | 1.051 (pass) | 0.970 (pass) | pass |
| leader/disk/write | 1.043 (pass) | 1.038 (pass) | 0.981 (pass) | pass |
| leader/memory/large-read | 1.059 (inconclusive) | 1.080 (pass) | 0.973 (pass) | inconclusive |
| leader/memory/large-write | 1.019 (pass) | 1.030 (pass) | 0.983 (pass) | pass |
| leader/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.058 (pass) | pass |
| leader/memory/read | 1.000 (pass) | 1.000 (pass) | 1.025 (pass) | pass |
| leader/memory/sync | 1.014 (pass) | 1.012 (pass) | 0.982 (pass) | pass |
| leader/memory/write | 1.000 (pass) | 1.033 (pass) | 0.989 (pass) | pass |
| sab/disk/large-read | 1.009 (pass) | 1.016 (pass) | 0.993 (pass) | pass |
| sab/disk/large-write | 1.019 (pass) | 1.034 (pass) | 0.982 (pass) | pass |
| sab/disk/metadata | 1.000 (pass) | 1.000 (pass) | 0.981 (pass) | pass |
| sab/disk/read | 1.063 (inconclusive) | 1.000 (pass) | 0.996 (pass) | inconclusive |
| sab/disk/sync | 1.000 (pass) | 1.026 (pass) | 0.980 (pass) | pass |
| sab/disk/write | 1.000 (pass) | 1.037 (pass) | 0.982 (pass) | pass |
| sab/memory/large-read | 1.033 (pass) | 1.029 (pass) | 0.983 (pass) | pass |
| sab/memory/large-write | 1.012 (pass) | 1.011 (pass) | 0.983 (pass) | pass |
| sab/memory/metadata | 1.000 (pass) | 1.000 (pass) | 1.000 (pass) | pass |
| sab/memory/read | 1.000 (pass) | 1.000 (pass) | 0.884 (inconclusive) | inconclusive |
| sab/memory/sync | 1.014 (pass) | 1.038 (pass) | 0.975 (pass) | pass |
| sab/memory/write | 1.000 (pass) | 1.000 (pass) | 0.991 (pass) | pass |
