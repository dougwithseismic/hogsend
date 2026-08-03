# DECISIONS — identity model

Global locked choices for the identity re-model. Every PRD inherits these. Written after the
ghost-contacts branch (#621) exposed that the bug class is structural, not incidental.

## §1 The problem, stated once

Two structural choices generate every identity bug we have hit:

1. **Identity is stored as COLUMNS on the contact row.** `contacts` carries `external_id`,
   `anonymous_id`, `email`, `discord_id`, `phone` — **one slot each**. A person gets one anonymous
   id. Reality is many (devices, browsers, cleared storage). This is why a second device's id had
   nowhere to go and was silently dropped.

2. **History is keyed by a DERIVED, MUTABLE STRING.** `contactKey = external_id ?? anonymous_id ??
   id`. When that key changes, five tables must be physically rewritten (`repointOwnHistory`). Every
   arm that can change the key must remember to repoint; forgetting is silent. Moving rows by
   *string match* is also what made a history-theft bug possible — a string collides across
   namespaces in a way a uuid FK cannot.

Everything downstream — adoption on three arms, the provenance guard, second-device aliasing,
idempotency handling — exists to service those two choices.

## §2 Verified starting facts (measured, not assumed)

- **The identity table already exists in the right shape.** `contact_aliases` is
  `(contact_id uuid, alias_kind text, alias_value text)` with `uniqueIndex(alias_kind, alias_value)`
  and `index(contact_id)`. That IS the target shape. It is currently a *fallback* consulted by
  `findByKey` after the columns miss, and is only populated on promote/merge. The work is to
  backfill it and promote it to source of truth — NOT to build it.
- **Five string-keyed tables**: `user_events`, `journey_states`, `bucket_memberships`,
  `email_sends`, `email_preferences`. These are exactly the five `repointOwnHistory` rewrites.
- **Four tables are already `contact_id uuid`**: `conversions`, `funnel_progress`, `deals`,
  `feed_items`. The direction of travel is established; this finishes it rather than inventing it.
- **133 non-test call sites** reference `<table>.userId` across those five tables
  (user_events 48, bucket_memberships 34, journey_states 29, email_preferences 15, email_sends 7).
  This is the dominant cost of the whole effort and it is concentrated in one PRD.

## §3 The target model

**X — one immutable identity, many keys.** `contacts.id` is the person and never changes. All keys
live in one table, `unique(kind, value)`. Kinds: `anonymous | external | email | discord | phone`.
Many rows per person per kind is normal. The identity columns on `contacts` become derived/legacy,
then dead.

**Y — history references `contact_id`, never a key string.** Identify stops rewriting history
entirely; it inserts an identity row. Merge becomes a uuid FK move, which cannot collide across
namespaces and cannot steal.

**Z — resolution is one function with explicit, data-driven trust.**
`resolve(keys[], { create, allowMerge, trustedKinds })`. Trust is a property of the KEY, declared
once by the route, not inferred from which arm ran. A publishable browser key may only ever assert
`anonymous`; a secret key anything; a verified `userToken` upgrades `external`.

## §4 Locked decisions

- **Additive-then-flip, never big-bang.** Every schema PRD lands as: add → backfill → dual-write →
  (separately) flip reads → (separately) delete the old path. A PRD that both adds and flips is
  split.
- **`contact_aliases` is extended, not replaced.** Renaming it to `contact_identities` is a cosmetic
  change that would touch every consumer for no behavioural gain. Keep the table and its column
  names; the semantic change is which code treats it as authoritative. Revisit the name only after
  the columns are dead.
- **No behavioural change is bundled with a migration step.** If a step reveals a bug, it is filed,
  not fixed in the same commit.
- **The five history tables get `contact_id` as NULLABLE first.** A NOT NULL constraint is a separate
  , final step, and only after a backfill verifies zero nulls in production.
- **Anonymous-only contacts are a DISPLAY concern, not a creation concern.** With identities in
  their own table, "has this person ever identified" is
  `EXISTS (identity WHERE kind <> 'anonymous')`. Studio filters on that. This is the cheap answer to
  the original ghost-contacts complaint and it does not require refusing to create.
- **`allowCreate` and the refusal sites from #621 stay.** They are orthogonal and independently
  valuable (they bound row growth). Do not unwind them as part of this.
- **Behaviour tests are the contract.** The tests written for #621 pin outcomes ("history follows the
  person", "you cannot take someone else's"), not mechanism. They must stay green through every step
  and are the primary evidence that a flip was safe.

## §5 Quality gates (verbatim, every task)

```
pnpm lint
pnpm exec turbo run check-types --concurrency=2
cd apps/api && HOGSEND_TEST_DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/ghost_clean pnpm exec vitest run
cd packages/engine && pnpm test
```

`turbo` FILTERS `HOGSEND_TEST_DATABASE_URL`, so the API suite MUST be invoked through `vitest`
directly. The shared `growthhog` database holds ~18k contacts and trips a whole-table walk in
`gtm-score-batch.test.ts`; use the clean database.

## §6 Publish mode

Branch + PR per PRD group against `main`. Conventional commits. No AI/co-author mentions. The engine
is published, so any public API change needs a changeset and `pnpm changeset:engine-line`.

## §7 Seams / open questions for the human

- Whether to run the production backfill online or in a maintenance window (row counts decide).
- Whether `phone` joins the identity table now or stays a column until SMS identity is re-modelled.
