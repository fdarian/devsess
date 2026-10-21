---
"devsess": patch
---

`daemon stop` and `restart` wait for the daemon process to exit before reporting it stopped, a freshly launched daemon gets 15 s to answer, and connect errors other than a missing daemon are reported with their errno.
