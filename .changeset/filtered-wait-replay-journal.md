---
"@hogsend/engine": patch
---

Fix #591: a crash-replay of a resolved filtered/group `ctx.waitForEvent` no longer fails the run with Hatchet's positional-journal non-determinism error when the journey has further durable primitives after the wait.

The `__waits__` terminal mark used to early-return the recorded outcome before re-issuing the wait's durable call, so the replay's next primitive landed on the wrong journal slot (and a re-computed sleep duration would have failed the param check even if it hadn't). The wait now NEVER skips a durable call on replay — instead every non-journaled input the control flow branches on is frozen set-once under `__waits__`: each scan result (`<label>:scan:<n>`, misses included), each arm's remaining-ms (`<label>:arm:<n>`, which is also the sleep parameter), and the deadline itself (`<label>:deadline`, independent of the resolution-cleared `waitDeadline` column). The replay walks the identical branch sequence, Hatchet answers each re-issued `waitFor` from the journal instantly, and the recorded outcome returns verbatim.

The unfiltered leg's `lookback` pre-check is frozen the same way (`<label>:lookback`) — whether a wait resolved via lookback is also a branch in front of a durable call, and it now registers the wait label, so an intra-run duplicate label on a lookback wait throws the loud collision error instead of silently replaying a stale hit.

Waits armed by 0.52.0 resume fine under this engine (the recorded deadline seeds from the stored `waitDeadline`); runs that already failed with the non-determinism error are terminal and re-enter on their next trigger.
