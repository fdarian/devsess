---
"devsess": patch
---

Bound daemon shutdown, record the daemon PID beside its socket, let `daemon start`/`stop --force` recover a daemon that accepts connections but never replies, and append daemon output to `daemon.log`.
