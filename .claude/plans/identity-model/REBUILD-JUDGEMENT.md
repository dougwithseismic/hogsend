# If we rebuilt identity from scratch: what survives, what is dead weight

Senior review, 2026-07-28, grounded in a full read of `lib/contacts.ts` (~2,300 lines), the seven
PRDs, and what building PRD 02 taught about how the parts actually interact.

**Headline: a respectable core survives, but it is IDEAS, not code.** By line count roughly **60% of
`contacts.ts` exists to service the two choices in DECISIONS §1** — one-slot identity columns and a
derived mutable string key. `repointOwnHistory` and its string folds, `keysAnotherContact`,
`collidesWithIdentified`, the uuid-in-key-namespace fallbacks, two adoption arms, and the incident
archaeology in the comments are all that stratum. In a rebuild they do not exist.

---

## 1. `contactKey` is THREE concepts fused, and none should share a representation

The string is simultaneously **join key**, **display name**, and **hash seed** (flag/holdout rollout).

- *Join key* → dies. uuid. No residue.
- *Display name* → a real need, but a READ-TIME derivation (`email ?? external_id ?? short(id)`).
  Never stored. The moment you store it you must maintain it, and maintenance is the whole disease.
- *Hash seed* → hash `contacts.id` from day one. Stable, uniform, no anonymous-population special
  case — and **the entire PRD 07 freeze apparatus never needs to exist.**

The one legitimate survivor of the string world: `user_id` on event rows as *"the key AS OBSERVED at
write time"* — immutable per row, **provenance not identity**, and exactly what
`mergeAnalyticsIdentities` needs for the PostHog distinct-id stitch. Keep the observed-key column,
kill the derived canonical key, never let the three roles share a value again.

## 2. There are FOUR resolvers. A rebuild has ONE.

`findByKey` (the real one), `resolveRecipient` (its own column-first + `resolveViaAlias`
mini-resolver), `routes/feed/recipient.ts` (direct `eq(contacts.anonymousId, …)`), and the
column-only readers in `connector-actions.ts` / `refine.ts` / `crm-ingest.ts`.

Every one is a place resolution semantics can silently diverge, and **two already have**:
- `resolveRecipient` returns `{ email, externalId: null, contactId: email }` — a raw EMAIL STRING in
  a field named `contactId`;
- `feed/recipient.ts` is blind to alias-held second devices (the PRD 03 T5 bug).

Nothing in the domain requires four answers to "who owns this key". This is the purest accidental
complexity in the system. Same family: `email_preferences.user_id` holds **three value-domains**
(external id, contact uuid, raw email) — the OR-of-two-legs lookups exist only to paper over that —
and the denormalized `userEmail` copies on `email_sends`/`journey_states` are mini string-keys that
merges must remember to rewrite. Emblematic: `contacts.ts` contains two identical uuid regexes.

## 3. `contact_aliases` serves THREE masters; give it one

Resolution index, merge audit (`from_contact_id`, `reason`), **and** release-rollback discriminator.
**Both erasure bugs came from asking "what kind of row is this?" when the only question an index can
safely answer is "whose is this?"**

Rebuild shape: an `identities` table of pure `(contact_id, kind, value)` — no `reason`, no
`from_contact_id` — so erasure is one keyed delete that cannot be gotten wrong. Plus an append-only
`merge_log` (from, to, at, cause) powering `followToSurvivor`, with its own separately-decided
erasure policy. `followToSurvivor` only ever needed the (from→to) fact; it never needed to live in
the resolution index.

## 4. The trust trio is TWO axes plus evidence, not three axes

- `allowCreate` — a real axis: the **side-effect budget**.
- `restrictToAnonymous` — **NOT an axis.** PRD 06's own L2 proves it is a derived consequence of
  "this caller may only assert anonymous keys". Evidence, not policy.
- The real second axis it gestures at is **write authority over existing state**, and it wants to be
  **graded, not boolean**: `observe < attach-key < merge-anon < merge-identified`.

Rebuild: `resolve(keys, { mayCreate, authority })`, authority computed once at the route from auth
evidence. The `arrive.ts` polarity case — the two flags holding OPPOSITE values in one request — is
the proof the two real axes are independent.

## 5. The three ARMS are right; per-arm SIDE EFFECTS are what rotted

Create / fill-in-link / merge is just the cardinality of the candidate set (0 / 1 / 2+). That match
is honest and survives. What made trust-by-code-path possible is that **each arm carried its own
inline policy and effects**: adoption living in two arms with separately-remembered gates,
`keysAnotherContact` guarding some attach sites and not others, clamps checked per-arm.

Rebuild: arms compute a **PLAN** (`{ attach, merge, adopt }`); policy is checked ONCE against the
plan; effects execute ONCE from it. With an identity table as truth, fill-in-link and merge nearly
converge (attach = insert a row; merge = uuid repoint + fold), so the arms get small enough to stop
being dangerous.

## 6. The `Kind` hierarchy is one real distinction under two accidental ones

"Resolvable but never canonical" (email/discord) exists ONLY because canonical-key derivation
exists — kill the key, the tier evaporates. Phone's "not merge-participating" is shipping-order
accident (SMS landed later), not domain truth.

The REAL distinction underneath is **IDENTIFIER vs ADDRESS**. email/phone/discord are delivery
destinations the send path load-bears on; external/anonymous are pure identifiers. That is domain
essence. A rebuild's kind carries: is-resolution-edge, is-delivery-address-for-channel-X, and
**verification level** (token-proven vs asserted) — which the system enforces at route gates today
but never STORES, which is precisely why trust had to be re-derived per code path.

## 7. `repointOwnHistory` dies; the FOLDS and the adoption stamp survive

Merge still needs "move this person's stuff", but as uuid UPDATEs — trivial. The irreducible residue
is **domain-aware conflict resolution when two live states collide**: one-active-enrollment-per-journey,
one-active-bucket-membership, and above all `foldEmailPreferences`' unsubscribe-never-lost
OR-semantics. No FK repoint gives you those; they are lifecycle-marketing essence and among the best
code in the file. Adoption survives too — the anonymous→known essence — but as ONE
`WHERE user_id = A AND contact_id IS NULL` stamp, not two arm-embedded string rewrites.

---

## Survives a rebuild UNCHANGED — do not throw these out

- **The observation-refusal principle** ("a contact is minted by identity, not observation"). A
  genuinely good idea whose implementation cost came from the string world, not the principle.
- **The engine-internal `contactId` provenance pin.** Unforgeable server-side subject threading is
  exactly right — and in a rebuild it is the ONLY way row uuids travel, which deletes the
  uuid-as-external-key fallback and the phantom-twin class outright.
- **Per-key advisory-lock serialization** at the top of the resolve transaction.
- **The fold semantics** (§7).
- **The publishable/secret boundary**, with browser-readable ids treated as non-secrets.
- **DECISIONS §4's "behaviour tests are the contract."** The #621 test corpus is the single most
  valuable asset in this subsystem.

## The direct answer to "compounding LLM decisions have made this hard"

The sediment is `contacts.ts`'s **incident archaeology** — hundreds of lines of comments encoding
past outages (the re-stitch storm, the docs sign-in order, the second-device drop) that every reader
must re-absorb before touching anything. **In a rebuild those become tests, not comments.** The
corpus proves the team already knows how.

## Essential vs accidental — the newcomer's map

**Essential** (irreducible to lifecycle marketing): anonymous-to-known adoption; merge with domain
folds; suppression/consent surviving every identity operation; channel addresses participating in
identity; erasure spanning every identity store; replay-safe idempotent writes; the browser/server
trust boundary.

**Accidental** (we invented it): everything downstream of the derived mutable key (repoint machinery,
both string-collision security guards, uuid-in-key-namespace fallbacks, the "never canonical" tier,
the PRD 07 freeze); one-slot-per-kind columns and their second-device special cases; the alias
table's triple duty; `restrictToAnonymous` as derivation instead of declaration; the four parallel
resolvers; the value-domain overloading in `email_preferences.user_id`.

A newcomer who internalizes that split can safely ignore **more than half** of `contacts.ts` as
historical scaffolding that PRDs 03–07 exist to demolish.

## The endorsement

The target model the PRD stack converges on — immutable id, identity rows, uuid history, declared
trust — **IS what a from-scratch build would choose.** It is not lipstick on the old model; it is the
rebuild, arriving in reversible steps.
