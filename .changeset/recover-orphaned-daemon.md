---
"devsess": patch
---

Recover from a live daemon whose socket file was unlinked: the CLI waits for it to re-bind, otherwise terminates and relaunches it, and `daemon stop` / `restart` now reach it.
