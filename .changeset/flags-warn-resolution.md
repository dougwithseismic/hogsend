---
"@hogsend/engine": patch
---

The flags reconciler's "key already owned by a non-code flag" warn now names
the resolution (fixes #574): set `origin = 'code'` on the row if it should be
contract-synced from `defineFlag`, or remove the same-key definition.
Behavior is unchanged — operator-owned rows are still never touched; the
papercut was that `origin` defaults to `"native"` on insert, so rows seeded
out-of-band for code-defined keys tripped a dead-end warn on every boot.
