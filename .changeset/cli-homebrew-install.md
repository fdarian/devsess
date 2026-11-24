---
"@devsess/cli": minor
---

The CLI now installs with `brew install fdarian/tap/devsess` as a standalone binary (no Node required) instead of from npm.

**Upgrading from the CLI bundled in `devsess` 0.6:** install with Homebrew, then run `devsess daemon restart`, since on macOS the launchd job points at the old install path.
