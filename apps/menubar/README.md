# Devsess menu bar

Native macOS 14+ menu bar companion for the devsess daemon. A terminal-prompt status item opens a menu-style panel with active runs and their services. Click a service row to open its URL; hover to stop its run, or use the row's context menu to restart, copy, reveal, or open its files. The footer stops all runs, opens logs, or quits with ⌘Q. It never starts the daemon; launching `dev start` does that.
Runs in `.claude/worktrees` also show a Claude starburst and session count in a clickable header badge. Live sessions use system orange; click to continue a session or choose among several.

Requires Swift 6 and macOS Command Line Tools (no Xcode). From this directory:

```sh
swift build
swift test
scripts/bundle.sh
.build/release/Devsess --snapshot build/snapshots
.build/release/Devsess --selftest-panel
```

The ad-hoc signed app is `build/Devsess.app`. Open it manually to use the panel; it has no Dock icon. `Devsess --list` performs a read-only daemon check. Snapshots do not connect to the daemon.
The self-test exercises the real status-item panel offscreen as active runs grow, shrink, and disappear, checking the visible panel's anchors, width, fitted size, soft corner-shadow pixels, and non-hit-testing margins. It also checks the stop zone's pointer geometry. macOS 26+ uses `NSGlassEffectView`; macOS 14–15 uses masked menu material. Both use a custom rounded shadow, not the system window shadow.

Snapshot mode captures busy, single, stress, empty, and daemon-down panels from the native panel hierarchy in both appearances as `panel-*-light.png` and `panel-*-dark.png`, plus `icons.png` (2x) and `icons-1x.png` (actual 1x pixels). Two-service hover and run-wide stop previews are `panel-hovered-{light,dark}.png` and `panel-stop-armed-{light,dark}.png`. The stress fixture exercises 20 active runs and the capped scrolling area. Snapshots never poll the daemon.
