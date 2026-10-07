# Manage the daemon

Read this when you need to check, stop, restart, or upgrade the shared per-user daemon.

```text
devsess daemon start
devsess daemon stop [--force]
devsess daemon status
devsess daemon restart [--force]
```

`daemon start` is idempotent and reports the PID. `daemon stop` requests a clean shutdown; it refuses while services are live unless `--force` is supplied, then waits for the control endpoint to become unreachable. `daemon restart` combines these operations. `daemon status` never starts anything: it reports the daemon identity, version, executable, Unix socket, state and service logs directories, uptime, and run/client counts. It exits with status `3` if the daemon is not running or not responding and warns when it differs from the CLI. An older daemon without the additive `info`/`shutdown` requests is reported as outdated; stop/restart identifies and verifies the process owning the socket before signaling it, rather than trusting stale run records.

If the socket accepts connections but the daemon never answers, `daemon status` reports it as unresponsive and shows its PID, which the daemon records in `devsess.pid` beside the socket. `daemon start` fails and names that PID; `daemon stop --force` (and `daemon restart --force`) sends it SIGTERM, then SIGKILL after a few seconds, and removes the socket. When no such process is alive, the socket is stale and `daemon start` or `daemon stop` clears it. A shutting-down daemon closes its socket first and answers any request still pending with an error. It gives runs 10 seconds to stop and then SIGKILLs the remaining process groups. The daemon's own stdout and stderr are appended to `daemon.log` in the logs directory.

The daemon has no TCP port. Its control socket is `$XDG_RUNTIME_DIR/devsess/devsess.sock`, or `/tmp/devsess-<uid>/devsess.sock` when that variable is unset. Its state directory is `$XDG_STATE_HOME/devsess`, or `~/.local/state/devsess` by default, and contains `running.json`. Service logs are in `$XDG_STATE_HOME/devsess/logs`, or by default `~/Library/Logs/devsess` on macOS and `~/.local/state/devsess/logs` on Linux. These paths are shared across worktrees; changing directory does not create another daemon. For log retention and replay, see `devsess docs read logs`.
