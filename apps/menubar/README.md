# Devsess menu bar

Native macOS 14+ menu bar companion for the devsess daemon. Shows runs and their services, published links, restart controls, and a hold-to-stop button. It never starts the daemon; launching `dev start` does that.

Requires Swift 6 and macOS Command Line Tools (no Xcode). From this directory:

```sh
swift build
swift test
scripts/bundle.sh
.build/release/Devsess --snapshot build/snapshots
```

The ad-hoc signed app is `build/Devsess.app`. Open it manually to use the panel; it has no Dock icon. `Devsess --list` performs a read-only daemon check. Snapshots do not connect to the daemon.
