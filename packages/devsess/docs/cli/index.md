# devsess CLI

`devsess` runs named groups of development services in a detached daemon shared by your user across projects and worktrees. It keeps each checkout's run separate while letting you return to the shell. The CLI requires Node.js on macOS or Linux; service commands can use any installed runtime, including Bun.

Install with `npm install -g devsess`. In a configured checkout, start a preset with `devsess start`, inspect it with `devsess status`, read output with `devsess tail`, refresh a service with `devsess restart`, and finish with `devsess stop`.

- configuration  Set up projects, presets, service commands, and readiness waiting.
- running  Start, inspect, restart, and stop a run.
- selecting  Choose a project, preset, run, or service when commands are ambiguous.
- logs  Read recent or live output and understand retention.
- attach  Send terminal input to a running service.
- completions  Install shell completion for commands, flags, and local presets.
- daemon  Manage the shared daemon and find its files.
- troubleshooting  Diagnose exit statuses, failed runs, and orphaned processes.

Read a topic with: `devsess docs read <id>`
