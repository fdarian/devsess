# Select a run or service

Read this when a bare command chooses the wrong scope or asks you to pick a run or service.

`stop --service <name>` (`-s`) selects one service just like `restart --service <name>`. Without `--service`, `stop` still stops the entire selected run, without a service picker.

Preset positionals accept a bare name or `project/preset`. A bare `stop`, `tail`, or `attach` considers only runs started under the current directory, never runs elsewhere. If no local run matches, the error lists active runs elsewhere with short IDs and explicit selection commands. With a selector these commands search across projects and prefer active runs. If no active run matches, `tail` replays the most recent matching finished run (under the current directory when no selector was given); `attach` reports its service exit status and gives the exact `tail` command. `stop` requires an active run.

The short run ID in `status` works as a positional selector, for example `devsess tail c585f251`, `devsess attach c585f251`, or `devsess stop c585f251`. `--run c585f251` also works. Displayed IDs lengthen to avoid collisions. A matching preset name takes precedence over an ID prefix; use `--run` when both match. A bare preset name still prefers a matching local run. Use `--project`, `project/preset`, or `--run <id>` to narrow repeated runs.

If several active runs match, an interactive terminal offers a preset picker; without one, the error lists fully qualified commands and short IDs. With several services, `tail` and `attach` offer a service picker (and name a run outside the current directory in the prompt). `--service <name>` (`-s`) skips the picker. Non-interactive invocations list exact `--service` commands; `tail --all-services` selects all services. `attach` needs an interactive terminal. Cancelling any picker with `Ctrl-C` exits with status `130` and restores a new shell line.
