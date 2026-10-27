---
'devsess': patch
---

Daemon re-binds its socket if the file is removed, exits cleanly if another process takes the path, and timestamps and explains its startup failures.
