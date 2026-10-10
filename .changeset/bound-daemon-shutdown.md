---
"devsess": patch
---

Bound daemon shutdown and run stops, answer `info` and run reads while the daemon is busy, make `daemon stop --force` terminate a daemon that cannot shut itself down, report a busy daemon by PID, release services whose exit could not be inspected, record the daemon PID beside its socket, let `daemon start`/`stop --force` recover a daemon that accepts connections but never replies, and append daemon output to `daemon.log`.
