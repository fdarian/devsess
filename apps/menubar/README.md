# Devsess menu bar

Native macOS 14+ menu bar companion for the devsess daemon. Shows runs and their services, published links, restart controls, and a hold-to-stop button. It never starts the daemon; launching `dev start` does that.
Runs in `.claude/worktrees` also show matching Claude Code sessions: coral for live or open, grey for archived. Click the badge to continue a session or choose among several.

Requires Swift 6 and macOS Command Line Tools (no Xcode). From this directory:

```sh
swift build
swift test
scripts/bundle.sh
.build/release/Devsess --snapshot build/snapshots
.build/release/Devsess --selftest-panel
```

The ad-hoc signed app is `build/Devsess.app`. Open it manually to use the panel; it has no Dock icon. `Devsess --list` performs a read-only daemon check. Snapshots do not connect to the daemon.
The self-test exercises the real status-item panel offscreen through repeated expand/collapse and run-list changes, checking its top anchor and fitted size.

Snapshot mode writes the busy, empty, and daemon-down panels plus `icons.png` (2x) and `icons-1x.png` (actual 1x pixels) to the specified directory.
It also captures `panel-live-busy.png` and `panel-live-single.png` from the native panel hierarchy in an offscreen window; neither capture polls the daemon.
`panel-live-stress.png` and `panel-live-stress-expanded.png` exercise one active run and 40 finished runs with long paths and commands.
