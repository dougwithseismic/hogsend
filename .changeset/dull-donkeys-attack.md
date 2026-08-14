---
"@hogsend/engine": minor
---

Add the account link store, the one writer of `linked_accounts`.

Every mutation runs in a single transaction that takes every advisory lock it
will need, sorted, as its first statement, so two players swapping platform
accounts cannot deadlock. Versions are monotonic per platform account across
live and unlinked rows, computed in SQL inside that lock, and cross every
boundary as strings because the value exceeds the JS safe integer range. A
relink burns two versions with the displaced row strictly below the new one, so
a consumer applying `incoming.version > stored.version` discards a late unlink
instead of recording the wrong owner. `afterLink` and `afterUnlink` are invoked
here and nowhere else, post-commit and fail-open.
