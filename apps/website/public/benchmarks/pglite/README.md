# PGlite speed-test SQL

Unmodified benchmark1.sql through benchmark16.sql from electric-sql/pglite
commit ae182ff8bd5ba4acb887d6c925d607a1498aa0b5, packages/benchmark/src.
Source: https://github.com/electric-sql/pglite/tree/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/benchmark/src

This is the 16-case workload in the published PGlite benchmark overview,
https://pglite.dev/benchmarks, descended from wa-sqlite and SQLite's historical
speed tests. It is not a formal industry benchmark standard.

The current upstream live runner additionally includes 2.1 and 3.1. We omit
those variants: 3.1 creates t3_1 but indexes t3, so its indexed-insert label is
misleading. The original 16 files run unchanged and in their original order,
one whole file per pg.exec call. No synchronous_commit override is applied.

The PGlite benchmark package is Apache-2.0; see LICENSE-APACHE-2.0. Its
wa-sqlite ancestry credits Copyright 2021 Roy T. Hashimoto; the inherited MIT
notice is preserved in LICENSE-WA-SQLITE-MIT. These upstream SQL assets retain
their upstream licensing, independently of the OPFS VFS project license.

manifest-16.json records source URLs and SHA-256 digests of the exact SQL bytes.
