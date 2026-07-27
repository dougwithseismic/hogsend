# PRD 09 — `hogsend-audience-to-cohort`

**Depends on:** 07. **Status:** `[~]` DEFERRED by decision, 2026-07-27.

Scoped, not fully specified. Flesh out to the full PRD shape when popped.

## Goal

Push a Hogsend bucket outward as a PostHog **static** cohort, created and updated via the
already-granted `cohort:write` scope.

## Why it is deferred rather than cut

PRD 07 delivers most of this PRD's stated value with none of its risk: once Hogsend writes
`hogsend_bucket_*` person properties, PostHog users can build their own cohorts from them
directly. The explicit push is a convenience on top of a capability they already have.

It also carries the highest cycle risk in the stack. It is, literally, the other half of
the feedback loop PRD 03 exists to prevent: this PRD creates PostHog cohorts, and PRD 02
imports PostHog cohorts.

Revisit on real demand.

## Locked decisions (carry into the full PRD)

- **Exported cohorts carry a machine-readable marker, and PRD 02's import refuses them.**
  This is the mandatory cycle break. Without it, an exported cohort can be re-imported into
  a bucket that feeds the export.
- Static cohorts only. Pushing a *dynamic* cohort definition would require translating
  bucket criteria into PostHog filter syntax, which is the mirror image of the
  definition-translation non-goal in DECISIONS §3.1 and is equally out of scope.
- Off by default, per-bucket opt-in.

## Open questions for when this is popped

- Update semantics: does a push replace the whole static cohort membership, or diff it?
  PostHog's static cohort API shape decides this.
- What happens when an operator edits a Hogsend-exported cohort inside PostHog. Likely
  answer: detect via the marker and refuse to overwrite, or overwrite and say so loudly.
- Volume: a 100k-member static cohort push against the same rate limits that bound PRD 02.

## Implementation Notes
