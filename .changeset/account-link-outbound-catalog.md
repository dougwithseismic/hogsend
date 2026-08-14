---
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/client": minor
---

Add `account.linked`, `account.unlinked` and `account.link_failed` to the outbound webhook catalog.

The catalog is public surface on all three packages, so all three version together. `WEBHOOK_EVENT_TYPES` (`@hogsend/engine`) is the single source of truth; the CLI's tuple and the client's `OutboundEventType` union are hand-maintained copies that cannot import the engine, and a drift test asserts all three stay in exact set agreement. Shipping the engine without the other two would publish an engine that emits three events the CLI cannot subscribe to and the client cannot type — the precise drift that test exists to prevent, escaping through the release instead of the code.

The two state events carry FULL CURRENT STATE rather than a delta: `{ state, provider, providerUserId, contactId, userId, email, version, at }`, plus `username`/`method`/`relink` on `account.linked` and `reason` on `account.unlinked`. A subscriber upserts on `(provider, providerUserId)` and applies only when `incoming.version > stored.version`, which makes duplicate, out-of-order and late deliveries all no-ops. `version` is a Postgres `bigint` serialized as a decimal STRING — compare it with `BigInt()` or a numeric column, never `parseInt`, because a value above `Number.MAX_SAFE_INTEGER` rounded through float64 breaks that guard invisibly.

`account.link_failed` carries no `version`, no `state` and no dedupe key: nothing mutated, so there is no current state to report and nothing to compare. Two genuine failures are two genuine facts, and suppressing the second would hide a brute-force pattern. It never mints a contact.

All three are emitted from the intent layer only — the hosted callback and the data plane — never from the ingest path, mirroring the `group.*` rule. The store returns mutation facts and emits nothing; two guards pin that, one scanning for the emit symbols and one pinning the store's runtime import list, so a future emit surface under a name nobody has invented yet still has to import its way past them.
