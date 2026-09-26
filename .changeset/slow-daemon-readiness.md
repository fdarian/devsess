---
"devsess": patch
---

`publishRunning` now waits up to 5 s for the devsess daemon to acknowledge readiness, instead of silently dropping it after 200 ms when the daemon is busy.
