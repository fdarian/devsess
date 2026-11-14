---
'devsess': minor
'@devsess/cli': minor
---

The `devsess` binary moved to `@devsess/cli`, so the library no longer installs `node-pty`; existing CLI users must `npm install -g @devsess/cli` and run `devsess daemon restart`, since the launchd job points at the old install path.
