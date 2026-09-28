---
title: Browser setup
description: Serve your app in a secure context with the isolation headers required by the worker APIs.
---

Browser storage belongs to an origin, defined by its scheme, hostname, and port. Serve production apps over HTTPS and use localhost for development. Worker APIs that rely on `SharedArrayBuffer` also need cross-origin isolation. Send these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Detect unavailable features before allocating user data, and show errors instead of attempting destructive recovery.
