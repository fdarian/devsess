---
"devsess": patch
---

A daemon that finds another one already serving the socket now exits 0 instead of being relaunched by launchd forever, no longer deletes that daemon's socket, and its `ps` calls get 3 s instead of 500 ms before failing.
