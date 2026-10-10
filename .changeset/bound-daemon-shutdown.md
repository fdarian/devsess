---
"devsess": patch
---

Bound daemon shutdown and run stops, answer `info` and run reads while the daemon is busy, make `daemon stop --force` terminate a daemon that cannot shut itself down, report a busy daemon by PID, release services whose exit could not be inspected, record the daemon PID beside its socket, let `daemon start`/`stop --force` recover a daemon that accepts connections but never replies, append daemon output to `daemon.log`, and stop leaking three file descriptors per service start on macOS by upgrading `node-pty` to 1.2.0-beta.15.
