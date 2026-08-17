---
"@hogsend/js": patch
---

The drop-in boot no longer mistakes the standard async loader stub (an object with queued `capture`/`identify` functions and a `_q` array) for an already-booted client; the queue replays as intended. Exports `STUB_METHODS`, the fire-and-forget list the documented loader stubs.
