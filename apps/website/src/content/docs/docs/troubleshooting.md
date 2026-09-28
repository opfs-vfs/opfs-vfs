---
title: Troubleshooting
description: Resolve worker, ownership, quota, and recovery errors while preserving saved data.
---

**The worker cannot start.** Confirm OPFS support, HTTPS or localhost, and COOP/COEP headers.

**A volume is busy.** Deletion and reset need exclusive ownership. Close other tabs using that volume, then retry; do not delete it to clear ownership.

**Quota or persistence fails.** Show the browser error and let the user choose specific files or volumes to remove. Never reset all origin storage.

**Mount recovery fails.** Preserve the volume and report the typed error rather than doing automatic destructive cleanup.
