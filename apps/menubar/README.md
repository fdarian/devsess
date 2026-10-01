# Devsess menu bar

Native macOS 14+ menu bar companion for the devsess daemon. A terminal-prompt status item opens a menu-style panel with active runs and their services. Click a service row to open its URL; hover to stop its run, or use the row's context menu to restart, copy, reveal, or open its files. The footer stops all runs, opens logs, or quits with ⌘Q. It never starts the daemon; launching `dev start` does that.
Runs in `.claude/worktrees` show a coral Claude starburst and muted count of non-archived sessions, or an archive symbol and count when all are archived. Click a single non-archived session to continue it; otherwise choose from a menu with open sessions first, green dots for live CLI processes, and an archived section. The badge capsule appears only on hover.

Requires Swift 6 and macOS Command Line Tools (no Xcode). From this directory:

```sh
swift build
swift test
scripts/bundle.sh
.build/release/Devsess --snapshot build/snapshots
.build/release/Devsess --selftest-panel
```

The ad-hoc signed app is `build/Devsess.app`. Open it manually to use the panel; it has no Dock icon. `Devsess --list` performs a read-only daemon check. Snapshots do not connect to the daemon.
The self-test exercises the real status-item panel offscreen as active runs grow, shrink, and disappear, checking anchors, fitted size, transparent corner pixels, and the view/layer hierarchy: one effect view inside a clear rounded clipping container, clear hosting/scroll backing, and no child windows. Synthetic mouse events check the service row's independent URL and stop buttons; pointer geometry checks hover arming. macOS 26+ uses `NSGlassEffectView`; macOS 14–15 uses masked menu material. The system window shadow is enabled and refreshed after display and resize. View-cache snapshots do not capture the WindowServer shadow or prove live compositor output.

Snapshot mode captures busy, single, stress, empty, and daemon-down panels from the native panel hierarchy in both appearances as `panel-*-light.png` and `panel-*-dark.png`, plus `icons.png` (2x) and `icons-1x.png` (actual 1x pixels). The busy fixture includes single-live, mixed (two open plus one archived), and all-archived (four) badges. Two-service hover and run-wide stop previews are `panel-hovered-{light,dark}.png` and `panel-stop-armed-{light,dark}.png`. The stress fixture exercises 20 active runs and the capped scrolling area. Snapshots never poll the daemon.
