# Run your services

Read this when you want to start, inspect, restart, or stop services in a checkout.

Expanded `status` output includes compact resident memory next to live service PIDs when available. Memory sums RSS across the service's process group and descendants that left it, counting each PID once. It is sampled on demand and cached for two seconds, never persisted, and omitted when unavailable; a sampling failure does not prevent status reporting. Displayed KB/MB/GB use powers of 1024.

For protocol-v1 clients, `stopServices` accepts `{ runId, serviceNames: string[], force?: boolean }` and returns the updated run record, just like `stopRun`. Names must be non-empty, distinct, and exist in the run. `listRuns` and `getRun` may include `memoryBytes: number` on each live service (RSS in bytes); finished services and unavailable samples omit the field. Clients must tolerate its absence, including responses from older daemons.

```text
devsess list [--names] [--config path] [--project name]
devsess start [options] [preset]
devsess status [-a|--all] [--project name]
devsess restart [options] [--service name | --all-services] [preset|run-id]
devsess stop [options] [--service name] [--force] [preset|run-id]
```

`list` reads the config and reports presets matched by the current directory, each service command and resolved working directory, and which presets await publication. It does not start the daemon. If the daemon is reachable, it marks active presets as running. Its bare-start summary explains whether `start` would choose one preset, offer a picker, or fail without a terminal.

`list --names` prints only selectors accepted by `start`, one per line: bare preset names for one matched project, or `project/preset` for multiple projects. It honours `--project` and `--config` and never contacts or starts the daemon. Shell completion uses this mode; see `devsess docs read completions`.

`start` captures the current environment and starts the selected preset through the detached daemon. It waits for a daemon handshake and acknowledgment, then observes the run for about two seconds and prints readiness publications as they arrive. If a service exits during that window, it prints the exit status, recent output, and an exact `tail` command; if every service fails, `start` exits nonzero. Otherwise it prints the run ID and returns to the shell while services continue. The run records the invocation directory.

With `awaitPublish: true`, `start` waits for every included service to publish readiness, with no default timeout. After 15 seconds it prints pending services and a `tail` command for each. If one exits without publishing, `start` reports its exit status and recent output and exits nonzero **without stopping the other services**. `Ctrl-C` stops waiting, not the services; check their progress with `devsess status`.

Only one active `project/preset` identity can run at a time. A completed or failed record can be reused only after every service process stops; a failed aggregate state can still have a live service blocking another start.

`status` reports active runs across projects with short run IDs. Runs under the current directory (or named with `--project`) show start time, uptime, and each service's state, PID, exit code, command, and working directory; other projects get a summary line. Published services show `ready` and their URL or named URLs; other published values appear as compact, truncated JSON. Readiness is persisted with the run and cleared when a service unpublishes or exits. `status` does not start the daemon; if it is down, it says so. When nothing is running, it shows the latest finished run from this directory (or latest overall) with exit codes and a `tail` command. One finished run per project, preset, and checkout is retained. `-a`/`--all` expands every active run; finished runs are never listed. `--project <name>` narrows results. For the daemon process itself, see `devsess docs read daemon`.

`restart` replaces one or more services in an active run without changing the run ID or interrupting other services. Choose `--service <name>` (`-s`) or `--all-services`; with several services, a terminal offers a picker and non-interactive use lists exact selection commands. It stops selected processes and descendants, appends a restart marker to their logs, and respawns them with the original command, working directory, and environment held in daemon memory. After a daemon restart, stop the run and start again before using `restart`: the environment is not saved in the registry. Readiness is cleared before respawn. For a service configured to await publication, `restart` waits for fresh readiness; an exit without publication prints recent output and a `tail` command and returns nonzero. Otherwise it reports that the service does not publish readiness and returns once spawned.

`stop` terminates an active run and its services. Use `--service <name>` (`-s`, matching `restart`) to stop only that service; other services keep running. Stopping an already finished service is a no-op. Stopping the last live service finishes the run. A stopped service in a still-active run can be started again with `restart --service <name>`. For how to choose a run or service, see `devsess docs read selecting`; for an orphaned group that needs `--force`, see `devsess docs read troubleshooting`.
