# PRD 22 — A half-provisioned domain never sends, and never heals

**Status:** `[ ]` · **Depends:** 07, 21 · **Boundary:** `apps/cloud`

## Goal

A domain whose provision died between `createIdentity` and `associateResource` is permanently unable
to send, reports itself healthy, and cannot be repaired by retrying. Fix that.

## The bug, verbatim

`apps/cloud/src/services/ses-domains.ts`, `create()`:

```ts
// EARS 2. A domain SES already knows falls through to a lookup …
const existing = await readIdentity(name);
if (existing) return snapshot(name, existing);     // ← line ~207
…
await ses.associateResource({                       // ← line ~249
  tenantName: tenant.tenantName,
  resourceArn: identityArn(tenant.tenantArn, name),
});
```

Forty lines apart, and everything between them can fail. If `createIdentity` succeeds and the process
dies, is redeployed, times out or is cancelled before `associateResource`:

1. The identity EXISTS in SES but is NOT associated with the tenant.
2. **Every send from that domain gets `AccessDeniedException` 403 — "Tenant not associated with
   resources"** (observed live on 2026-08-11, so this is not a hypothesis about SES's behaviour).
3. Re-running `create()` short-circuits at `if (existing)` and returns a healthy-looking snapshot
   without ever associating.
4. `verify()` is a pure read and does not associate either.

So the domain is bricked for sending, reports itself fine, and no retry path repairs it. The comment
directly above the association call states the stakes exactly right — "Without this line every send
from the new domain is rejected" — while the early return above skips that line.

## Why this was found now

PRD 21 chased a divergence between the Fake and AWS and concluded, wrongly at first, that the Fake let
sends through unassociated. It does not. But the failure that claim DESCRIBED — "a provision that
forgot `associateResource`" — turned out to be real and to live in production code rather than in the
Fake. The instinct was right about the failure class and wrong about the layer.

## Locked decisions

- **The existing-identity path must re-assert the association**, not assume it. Association is the
  cheap idempotent call; a `createIdentity` that already succeeded is the expensive one to skip.
- **Handle an already-associated resource as SUCCESS.** If SES answers `already_exists` (or its
  equivalent) for a resource the tenant already holds, that is the desired state, not an error. Do
  NOT assume which it does — the seam's error kinds are known and the Fake models re-association as a
  no-op; confirm what AWS does before relying on either.
- **This must not cost a second DKIM key.** The early return exists so a known domain never mints a
  new keypair (EARS 2 of PRD 07). Re-asserting the association must sit AFTER the lookup and must not
  reopen the keypair branch.
- **A repair must be observable.** A domain that was silently broken and is now fixed should say so —
  at minimum an audit entry distinguishable from a first-time creation.

## Acceptance criteria (EARS)

- WHEN `create()` is called for a domain whose identity exists but is NOT associated with the tenant,
  the system SHALL associate it and SHALL report the domain as usable.
- WHEN `create()` is called for a domain already associated, the system SHALL succeed and SHALL NOT
  mint a new DKIM keypair.
- WHEN the association call reports the resource is already associated, the system SHALL treat that as
  success.
- WHEN a provision fails between identity creation and association, a subsequent `create()` SHALL
  leave the domain in the same state as an uninterrupted run.

## Tasks

1. **A failing test first**: a `create()` interrupted after `createIdentity`, re-run, then a send —
   asserting the send succeeds. Against the Fake this now works, because PRD 21 taught
   `associateResource` that resources must exist and the Fake already refuses an unassociated send.
   _Boundary:_ `apps/cloud` · _Depends:_ none
2. **Re-assert the association on the existing-identity path**, tolerating already-associated.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1
3. **Confirm SES's real answer** for associating an already-associated resource, and make the Fake
   match it. Do not guess: this is the same discipline that produced every correction in this wave.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2
4. **Sweep for the same shape elsewhere.** Any other provisioning path with an early return upstream
   of a required side effect has this bug. `pipeline/provision.ts` is the obvious next place to look.
   _Boundary:_ `apps/cloud` · _Depends:_ none

## Seams

- Task 3's confirmation needs real AWS. Credentials and a verified sender both exist as of
  2026-08-11.

## Done when

An interrupted domain provision heals on retry, the healed domain sends, no second keypair is ever
minted, and gates are green.

## Implementation Notes

Fixed 2026-08-11. `create()`'s existing-identity path now re-asserts the association through one
`associateIdentity` helper shared with the fresh path — the bug was precisely that only one of the two
paths had it.

### The duplicate-association question was MEASURED, and the docs would have misled us

The plan said not to guess what SES answers for associating an already-associated resource. Reading
the API reference alone would have produced the wrong answer: `CreateTenantResourceAssociation`
documents **`AlreadyExistsException` (HTTP 400)** among its errors, which reads like a duplicate is
refused.

A probe against real SES on 2026-08-11 — create tenant + configuration set, associate the same ARN
twice, tear down — answered:

```
first  associateResource: OK
second associateResource: OK  → AWS ACCEPTS a duplicate
```

So the Fake's long-standing "re-asserting an association is a no-op" is CORRECT, and had this PRD
"fixed" the Fake to throw on the strength of the docs, it would have invented a divergence rather than
closed one. That is the second time in this wave that a listed-but-unfired error nearly drove a wrong
change.

The production code still tolerates `already_exists`, deliberately and with the measurement recorded
beside it. The asymmetry decides it: swallowing an error AWS never sends costs one branch, while a 400
on the repair path would fail the very call that exists to unbrick a domain.

### Verified by mutation

Removing the `associateIdentity` call from the existing-identity path turns exactly one test red —
the new `heals a provision that died between createIdentity and associateResource` — and restoring it
returns the file to 38 passing.

The test asserts the domain **SENDS** after the retry, not that `associateResource` was called.
Asserting the call would pass against a call naming the wrong ARN, which is the bug one layer down
that PRD 21 fixed the same day.

### The sweep (task 4) found nothing else

`services/ses-tenants.ts` provisioning is a linear sequence of idempotent steps wrapped in
`tolerate(["already_exists"])`, with no early return upstream of a required side effect; a re-drive
restates every one. Its comment claiming re-association is a no-op "in BOTH implementations" is now
independently confirmed against real AWS by the probe above.
