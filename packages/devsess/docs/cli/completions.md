# Shell completion

Load completion in your shell after installing `devsess`:

```zsh
# zsh: after compinit
eval "$(devsess completions zsh --alias dev)"
```

```bash
eval "$(devsess completions bash --alias dev)"
```

```fish
devsess completions fish --alias dev | source
```

Add the appropriate line to your shell's startup configuration to load it in future sessions. For zsh, initialise completion with `autoload -Uz compinit; compinit` before the install line.

Full Bash completion requires Bash 4 or newer: Effect's built-in flag completion uses associative arrays, which macOS's bundled Bash 3.2 does not support. Dynamic `start` preset completion works on Bash 3.2, but static flag completion does not.

Omit `--alias dev` if you only use the `devsess` command. Repeat `--alias` for additional command names; this registers completion but does not create shell aliases. Alias names must start with a letter or underscore and contain only letters, digits, underscores, or hyphens.

Subcommands and flags use Effect's built-in completion. `devsess start <TAB>` also offers presets available in the current directory. `--project` and `--config` before the preset are forwarded to `devsess list --names`; no daemon is contacted or started. Other commands do not get dynamic preset or run completion. Configuration errors are silent during completion; run `devsess list --names` directly to see them.
