# Devsess menu bar

Native macOS 14+ menu bar companion for the devsess daemon. A terminal-prompt status item opens a menu-style panel with active runs and their services. Click a service row to open its full URL; its leading stop square stops only that service. Hovering that square arms only its row. Hover a run header to reveal a whole-run stop square immediately left of its Claude badge, or at the trailing edge without one; arming it labels the header “Stop N servers” and turns that run's service squares red without changing their names. The badge stays visible and clickable at its resting trailing position in all header states, with layout reserved so nothing shifts. The footer stops all runs, opens logs, or quits with ⌘Q. It never starts the daemon; launching `dev start` does that.
Rows show localhost URLs as port-only links (for example `:58356`), otherwise the host. Optional daemon `memoryBytes` values appear as binary-unit memory labels (`1.2 GB`, `340 MB`) in a 48pt column left of the 48pt port column; starting/failure status text hides memory. Service context menus still offer restart, copy, reveal, and file actions. Per-service stop requires daemon `stopServices` support; older daemons' errors appear inline under the run section.
Runs in `.claude/worktrees` show a coral Claude starburst and muted count of non-archived sessions, or an archive symbol and count when all are archived. Click a single non-archived session to continue it; otherwise choose from a menu with open sessions first, green dots for live CLI processes, and an archived section. The faint badge capsule appears only on hover; counts use secondary label color on hover, with tertiary reserved for archived badges at rest.

Requires Swift 6 and macOS Command Line Tools (no Xcode). From this directory:

```sh
swift build
swift test
scripts/bundle.sh
.build/release/Devsess --snapshot build/snapshots
.build/release/Devsess --selftest-panel
```

The ad-hoc signed app is `build/Devsess.app`. Open it manually to use the panel; it has no Dock icon. `Devsess --list` performs a read-only daemon check. Snapshots do not connect to the daemon.
The self-test exercises the real status-item panel offscreen as active runs grow, shrink, and disappear, checking anchors, fitted size, transparent corner pixels, and the view/layer hierarchy: one effect view inside a clear rounded clipping container, clear hosting/scroll backing, and no child windows. Synthetic mouse events check URL opening, separate stops for both services in a two-service run, no-URL rows, and the header's whole-run stop. Pointer geometry checks hover arming. macOS 26+ uses `NSGlassEffectView`; macOS 14–15 uses masked menu material. The system window shadow is enabled and refreshed after display and resize. View-cache snapshots do not capture the WindowServer shadow or prove live compositor output.

Snapshot mode captures busy, single, stress, empty, and daemon-down panels from the native panel hierarchy in both appearances as `panel-*-light.png` and `panel-*-dark.png`, plus `icons.png` (2x) and `icons-1x.png` (actual 1x pixels). The busy fixture includes memory telemetry and single-live, mixed (two open plus one archived), and all-archived (four) badges. Two-service previews include `panel-header-hovered-*`, `panel-header-armed-*`, and `panel-service-armed-*`; the latter arms only the first service. `panel-badge-hovered-*` and `panel-badge-hovered-live-*` check archived/live badge contrast. `panel-hovered-*` and `panel-stop-armed-*` retain the row hover/armed previews. The stress fixture exercises 20 active runs and the capped scrolling area. Snapshots never poll the daemon.
