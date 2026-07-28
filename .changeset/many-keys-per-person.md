---
"@hogsend/engine": minor
---

Many keys per person: a second value for any identity kind is an identity row,
never a silent drop.

The `contacts` columns hold one slot per kind, so a second anonymous id, email,
external id or discord id used to be dropped — and a later resolve on the
dropped value minted a duplicate person. Now every supplied key the columns
cannot hold is recorded in `contact_aliases` through one uniform claim path, on
the fill-in-link arm and the collide-merge arm alike, and resolves back to the
same contact. Only a newly claimed anonymous key adopts orphaned pre-identify
history; other kinds add a resolution edge and move nothing.

**Security tightening (breaking only for pathological inputs).** Claims of
`external`/`anonymous` values are now uniformly gated: a value that is another
live contact's CANONICAL key is refused — no column write, no identity row, no
history move — and logged as `identity.claim.refused_foreign_key` with the kind
and contact id (never the value). Previously one attach arm shipped ungated: a
caller could have a victim's canonical key written into their own
`anonymous_id` column (and worse, an ungated `external_id` attach could flip
the caller's canonical key onto a string another person's history keys on). An
operator whose ingest legitimately supplies one contact's canonical key as a
different person's id will see those claims refused; grep the log line above to
find them.

**Bell fix.** The feed's anonymous recipient resolver now falls back to the
identity table, so a SECOND device whose anon id is held as an identity row is
recognized: its mark/clear re-ingests fold into the owning contact instead of
being refused and stranding events under the raw device id.

Internals: `anonAliasAlreadyHeld` is gone — first-claim detection is structural
(`ON CONFLICT` + `RETURNING` on the `(alias_kind, alias_value)` unique index),
so a browser that identifies on every page load cannot re-adopt or re-fire the
analytics anon→known stitch. `keysAnotherContact` and `repointOwnHistory`
deliberately remain: they guard string-keyed history and are PRD 05's to
retire.
