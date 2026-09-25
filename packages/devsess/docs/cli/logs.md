# Read service output

Read this when you need recent output, a live stream, or the location and limits of retained logs.

`devsess tail [options] [-n N] [-f] [--all-services] [preset|run-id]` prints the last 10 lines of retained output per selected service and exits. Use `-n N` or `--lines N` to change the count, including `0`; use `-f` or `--follow` to continue streaming. For a finished run it announces replay and returns the saved exit status in either mode. A picker can offer all services; `--all-services` selects them without a prompt. For choosing runs and services, see `devsess docs read selecting`.

With several services selected, each output chunk is prefixed with `[service-name] `; a chunk may contain several lines, so the prefix does not repeat on every line. A single service has no prefix. ANSI escape sequences are stripped when stdout is not a terminal.

Each service keeps append-only JSONL in a current segment and one previous segment, each bounded by the 1 MiB retention budget. Logs live at `<run-id>/<service-name>.jsonl` under the service logs directory; the previous segment is `.1.jsonl`. `devsess daemon status` shows that directory. On macOS without `XDG_STATE_HOME`, older logs under `~/.local/state/devsess/logs` are not migrated or replayed; older `.json` log documents are ignored. A partial trailing line from a crash is ignored.

A slow reader cannot throttle a service. If a live tail overflows, it gets an error and disconnects; rerun `devsess tail` to replay output still within the retained segments. For exit codes on completion, see `devsess docs read troubleshooting`.
