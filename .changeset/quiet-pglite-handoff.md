---
'devsess': patch
---

`prepareSessionPglite` now closes its PGlite connection and returns only `dataDir` and `dumpPath`; use `openLitePglite` for an in-process client.
