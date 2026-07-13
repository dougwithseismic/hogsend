# Strict privacy mode (design)

> **Status: design doc — not built.** Phase 8.3 of `docs/revenue-attribution-plan.md`
> (formerly "GDPR lead-gen mode" — renamed because the posture is generic; the
> statutes and the lead-gen market are the motivation, not the API).
> An **opt-in operator mode** (`privacy.mode: "strict"`): nothing here changes
> default behavior for existing deployments. This is engineering design informed
> by GDPR/PECR as practitioners read them — it is not legal advice, and an agency
> deploying it still needs its own DPO/counsel sign-off on their specific
> processing.

## Why this exists, and who it's for

Hogsend's attribution spine works precisely because it *remembers* things:
which ad click landed this person, which emails they clicked, what they
bought, and how to tie an anonymous browser session to the contact who later
signs a £14k contract. That memory is the product.

For most self-hosted deployments — a dev-tools company doing lifecycle email
to its own signups — that memory is uncontroversial: first-party data about
your own users, processed under contract / legitimate-interest bases.

UK/EU **consumer lead generation** is a different regime. An agency running
solar / home-improvement / finance campaigns:

- processes high volumes of *consumer* PII **on behalf of clients** — making
  it a GDPR Art. 28 **processor** whose clients demand a DPA with concrete
  retention and security answers;
- **stitches paid-ad behavior to identified individuals** — squarely PECR
  (device storage/access needs consent) plus GDPR profiling territory;
- gets the same four questions in every procurement round:
  1. *What do you retain, and for how long?*
  2. *You link ad clicks to people — where's the consent?*
  3. *Can you honor an erasure request without destroying your reporting?*
  4. *Show me the record of where this person's data came from.*

Today Hogsend's honest answers are "indefinitely", "we don't record it",
"sort of", and "the git history". This mode changes those answers to ones an
agency can put in a DPA. **It is the gate on selling Hogsend into the UK
lead-gen licensing market** (the SOS-shaped agencies; license values in the
£40–100k band) — those deals do not close without it, and nothing else in
the product needs it. Hence: a mode, off by default, scoped not skipped.

The three parts map one-to-one onto the procurement questions:

| Part | Legal driver | Question it answers |
| --- | --- | --- |
| 1. PII TTL split | Storage limitation (Art. 5(1)(e)); erasure (Art. 17) | "What do you keep, for how long?" + "delete me" |
| 2. Consent-gated stitching | PECR reg. 6; Art. 6 lawful basis for tracking | "Where's the consent for linking clicks to people?" |
| 3. Provenance ledger | Records of processing (Art. 30); SARs (Art. 15) | "Prove where this data came from." |

## The design principle: value survives, identity dies on schedule

One idea underpins all three parts: **split what the business needs forever
from what identifies a person, and only the former is durable.**

Revenue totals, attribution credits, funnel counts, journey stats — the
aggregate value Hogsend exists to produce — are keyed to opaque UUIDs and
survive indefinitely. The identifying layer (emails, phones, IPs, click IDs,
message bodies) is a **TTL'd projection** over those keys: useful while
fresh, scrubbed on schedule, and scrubbable *on demand* for one person
(erasure is just a TTL of zero for one contact — the same code path).

This is why the mode is cheap relative to its unlock: the schema already
separates identity from value almost everywhere (`attribution_credits`
carries no direct identifiers; `deals`/`conversions` join through UUIDs;
`contacts` already soft-deletes with live-row partial-unique indexes built
for the merge machinery). The mode mostly adds *scrubbing*, not *structure*.

---

## Part 1 — PII TTL split

### What we hold today (the inventory)

Verified against `packages/db/src/schema/` as of 0.44.0-pre:

| Table / surface | PII held | Class |
| --- | --- | --- |
| `contacts` | `email`, `phone` (E.164), `discordId`, `externalId`, `anonymousId`, `properties` jsonb (names, addresses — whatever the operator sends) | **contact identity** |
| `contact_aliases` | historical identity keys folded by merges | **contact identity** |
| `user_events.properties` | `fbclid`/`gclid`/`ttclid`/… on `campaign.arrived`, form payloads on `lead.submitted`, arbitrary operator properties | **tracking data** / **contact identity** |
| `link_clicks` | `ipAddress`, `userAgent` per click | **tracking data** |
| `email_sends` | `toEmail`, `subject` | **message record** |
| `sms_sends` | `phone`, full message `body` (stored for idempotent re-drive) | **message record** |
| `conversions` | `userKey` (canonical contact key) | joins only — scrubbed transitively via contacts |
| `conversion_dispatches` | payloads carry SHA-256 hashed `em`/`ph` for CAPI | **message record** (hashes are pseudonymized, still personal data under GDPR) |
| `email_preferences`, `sms_suppressions` | emails / phones on opt-out lists | **exempt — retained** (see below) |
| `audit_logs`, `auth` sessions | staff `ipAddress`/`userAgent` | operator's own staff — out of scope for this mode |
| `webhook_deliveries`, `dead_letter_queue`, `journey_states.context`, `import_jobs` | event payload copies in transit/replay buffers | **tracking data** TTL applies (they are buffers, not ledgers) |

What is deliberately **not** in the inventory: `attribution_credits` (channel
+ event class + timestamps, no identifiers), `deals` values and stage
timestamps, all rollups. These survive untouched — that's the point.

### Mechanism: scrub in place, never drop rows

A **retention reaper** — a Hatchet cron task in the mold of `crm-reconcile` —
sweeps each class past its TTL and **nulls/pseudonymizes the PII columns
while keeping the rows**:

- `link_clicks`: null `ip_address` + `user_agent` past the tracking-data
  TTL. Click counts, timestamps, and the semantic-link answers stay.
- `user_events.properties`: strip a defined identifier key-list (`fbclid`,
  `gclid`, `ttclid`, `msclkid`, `li_fat_id`, `rdt_cid`, `ip`, `email`,
  `phone`, plus operator-configurable extras) from events past the TTL.
  Event name, value, currency, `occurredAt` stay — rollups are untouched.
- `sms_sends.body` / `email_sends.subject`: replaced with a `[scrubbed]`
  marker past the message-record TTL. Delivery/open/click state stays.
- `contacts`: after the **identity TTL of inactivity** (no event, send, or
  deal touch), the contact is **anonymized in place** — identity columns
  nulled, `properties` emptied, row and UUID kept so every FK, credit, and
  deal still resolves. This reuses the exact live-row partial-unique index
  design the merge machinery already runs on (a nulled `external_id` simply
  leaves the unique index, like a soft-deleted loser row does today).

Scrubbing is **batched SQL updates** (no per-row round trips), each sweep
writes one audit row (class, cutoff, rows touched), and the reaper is
idempotent — a re-run over already-scrubbed rows matches zero.

### Erasure = TTL of zero for one person

`POST /v1/admin/contacts/:id/erase` (admin key) runs the *same scrub
functions* with `cutoff = now` scoped to one contact, immediately:
anonymize the contact row, strip their event properties, null their
tracking data, scrub their message bodies, and write a **tombstone** row to the
provenance ledger (Part 3) recording that erasure happened — the one fact
you must keep about a person you've erased. Because it's the reaper's code
path, there is no second implementation to drift.

The existing soft-delete (`deletedAt`) is *not* erasure — it hides a row
from resolution but keeps the data. Erase composes with it: erase scrubs,
soft-delete hides.

### The suppression exemption

Opt-out lists (`email_preferences` unsubscribes, `sms_suppressions` STOP
rows) are **never expired** — forgetting an opt-out is itself a violation
(you'd re-contact someone who said stop). In strict mode they are stored
as **salted hashes** at scrub time: inbound sends hash the candidate
address/phone for the check, so the gate keeps working with no plaintext
retained. Lawful basis: legal obligation / defense of legal claims — the
standard, defensible carve-out.

### Configurability (the answer is yes — per class)

Everything is operator config, grouped under one `privacy` option on
`createHogsendClient`, with env mirrors for container deploys:

```ts
createHogsendClient({
  privacy: {
    mode: "strict",                 // opt-in; omit ("standard") = today's behavior, no reaper
    retention: {
      trackingData: days(90),       // IPs, user agents, click IDs, payload buffers
      messageContent: days(365),    // SMS bodies, email subjects, dispatch payloads
      contactIdentity: days(730),   // anonymize contacts inactive this long
    },
    stitching: "consent",           // Part 2: "open" (default) | "consent"
  },
});
// HOGSEND_PRIVACY_MODE=strict
// HOGSEND_RETENTION_TRACKING_DATA_DAYS=90
// HOGSEND_RETENTION_MESSAGE_CONTENT_DAYS=365
// HOGSEND_RETENTION_CONTACT_IDENTITY_DAYS=730
```

Boot-time validation, because TTLs interact with features:

- `trackingData` shorter than any conversion definition's
  `attributionWindowDays` → **loud warning**: a conversion firing after the
  evidence is scrubbed cannot reconstruct `fbc` for CAPI and its credits
  lose click detail (they still write — the Unattributed/coverage surface
  from #425 is exactly where the honesty shows up).
- Hard floors (e.g. ≥ 7 days) so a typo can't scrub yesterday's campaign.
- `retention` without `mode: "strict"` → error, not silent no-op: the
  reaper only exists inside the mode, and half-on states are how operators
  end up believing they're compliant when they aren't.

Defaults above are deliberate: 90 days of tracking data covers the default
attribution window exactly; 12 months of message content covers a complaint
cycle; 24 months of identity is the common agency DPA ask. All three are
the operator's call — the mode's job is to make the answer *true*, not to
pick it.

### What Part 1 unlocks

- A one-paragraph retention answer for DPAs, with config as evidence.
- Art. 17 erasure honored in seconds, **without losing a penny of reported
  revenue or a single attribution credit** — the demo that closes the deal.
- Smaller breach blast radius (old evidence simply isn't there), which
  feeds directly into the security section of the same procurement doc.

---

## Part 2 — Consent-gated stitching

### The stitching we do today (what needs gating)

1. **`@hogsend/js` identity + attribution persistence** — localStorage-backed
   store (pluggable adapter, `packages/js/src/types.ts`); `campaign.arrived`
   fires on click-ID/UTM arrival and the attribution set persists as
   last-touch for form prefill via `getAttributionFields()`.
2. **`hs_t` identity tokens** — encrypted token on tracked redirects,
   exchanged at `POST /v1/t/identify` for cross-device identification.
3. **Anonymous→identified folds** — cold-connect email fold, lead-form
   `buildLeadSubmission` binding, alias merges on re-ingest.
4. **CRM alias links** — CRM contact/deal IDs tied to the Hogsend contact.

Under PECR reg. 6, storing/reading identifiers on the visitor's device needs
prior consent unless strictly necessary — (1) and (2) are squarely that.
(3) and (4) are server-side (PECR doesn't bite) but still need an Art. 6
basis; for consumer lead-gen the defensible one is the consent/notice
captured *at the form itself* — which is exactly what the
sources-and-prospects consent work records.

### Mechanism: a recorded signal, checked fail-closed

**The signal.** One contact-level consent state for tracking/stitching,
recorded through the existing preference-write choke (which already carries
`source` provenance as "the consent audit signal" —
`packages/engine/src/lib/preferences.ts`). Sources of the signal:

- Browser: `hogsend.setConsent({ tracking: true })` in `@hogsend/js` —
  wired to the cookie-consent banner's analytics category (the #343 system
  already emits consent audit events; this makes the engine *store* the
  state, not just observe it).
- Server: the lead-form submission itself (`buildLeadSubmission` gains a
  consent field carrying the notice text version), or the operator's own
  consent capture via the SDK/API.

**The gates (only in `stitching: "consent"`):**

- `@hogsend/js` pre-consent runs **memory-only**: the storage adapter is
  already pluggable, so this is adapter selection, not a rewrite. Attribution
  fields are held for the session and flushed to persistent storage the
  moment consent lands; no consent → they die with the tab. `campaign.arrived`
  still fires (server-side event, ad-blocker-proof) but carries a
  `consented: false` marker.
- `POST /v1/t/identify` (`hs_t` exchange) requires recorded consent — no
  consent, no cross-device identify, token burned unused.
- Anonymous→identified **alias folds require either recorded consent or a
  form-submission basis** — the person handing over their email with notice
  *is* the basis; a purely behavioral fold (same device, no notice) is not.
- Everything transactional is untouched: sends, preference centers,
  unsubscribes, suppression checks never depend on tracking consent.

**The posture is fail-closed**, mirroring the SMS TCPA precedent (no
explicit consent → marketing SMS fails closed with `no_consent`): no
recorded consent → no stitch. Events still land — anonymous, unlinked,
feeding aggregate stats — and conversions from unconsented paths surface in
the **Unattributed** coverage introduced in #425 rather than silently
inflating channel credit. The reporting stays honest about what consent
costs, which is itself a selling point to agencies burned by tools that
quietly guess.

### What Part 2 unlocks

- A straight-faced answer to the ICO's cookie/tracking guidance — the
  banner, the stored consent state, and the gates form one auditable chain.
- Agencies can run UK consumer campaigns on Hogsend without inheriting a
  "track first, apologize later" posture from their tooling.
- The coverage/Unattributed surface turns consent loss into a *visible,
  measurable* number instead of invisible attribution rot — you can tell a
  client "62% of conversions are consented-attributable" and mean it.

---

## Part 3 — Provenance ledger

### What already exists (this part is half-built)

- `contacts.source` — the Source id that first created each contact
  (sources-and-prospects work; already live in the schema).
- The preference-write choke records `source` on every consent/preference
  flip — comments in `preferences.ts` and `webhook-signing.ts` already call
  it "the consent audit signal".
- The sources-and-prospects branch is building cold-posture provenance
  (which Source minted a prospect, under what posture).

The ledger generalizes these from scattered columns into one queryable
record.

### Mechanism: append-only `data_provenance`

One append-only table, written at the ingest boundaries where data enters:

```
data_provenance
  id            uuid
  contact_id    uuid            -- survives anonymization (tombstones need it)
  data_class    text            -- identity | consent | preference | evidence | erasure
  source        text            -- lead-form:solar-quiz | webhook:clay | crm:ghl | import:csv-2026-07 | sdk | admin
  basis         text            -- consent | contract | legitimate_interest | legal_obligation
  detail        jsonb           -- consent text version, form URL, actor, notice snapshot
  occurred_at   timestamptz
```

Writers: lead-form ingestion (with the consent text version shown),
webhook sources, CRM sync (first link + hydrates), imports, admin edits,
the consent signal from Part 2, and the erasure endpoint (tombstone).
Each writer is one insert at a boundary that already exists — no new
pipeline.

Surfaces:

- **Contact drawer provenance panel** in Studio — the audit trail per person.
- **`GET /v1/admin/contacts/:id/export`** — one JSON bundle of everything
  held about a person *plus* its provenance: a subject-access request
  answered in minutes instead of a week of SQL archaeology.
- **Art. 30 report** — records of processing generated *from the data*
  (`SELECT data_class, source, basis, count(*) ... GROUP BY`), not
  maintained by hand in a doc that drifts.

### What Part 3 unlocks

- SAR response time collapses from days to minutes — the single most
  operationally painful GDPR obligation for an agency at volume.
- The DPA's "records of processing" exhibit is a query, not a promise.
- It composes with Parts 1–2: erasure tombstones live here; consent
  versions live here; the retention answer is *provable* here.

---

## Rollout (three independently shippable stages)

1. **Retention reaper + config + erasure endpoint** (Part 1). Self-contained,
   biggest procurement value, no dependency on other branches. Ships with
   tests that seed each PII class, run the reaper, and assert rollups are
   byte-identical before/after.
2. **Consent-gated stitching** (Part 2). Depends on the sources-and-prospects
   consent primitives merging first (the consent field + posture work);
   the `@hogsend/js` memory-adapter piece can land independently.
3. **Provenance ledger + SAR export** (Part 3). Generalizes columns that
   land in stage 2; the export endpoint arrives here because it needs the
   ledger to be worth exporting.

Each stage: full per-stage discipline, its own changeset, calm-release.

## Non-goals

- **Not default-on.** Existing deployments see zero behavior change.
- **Not a compliance certification** and not legal advice — it makes the
  honest answers *good*, the agency's counsel makes them *sufficient*.
- **Not workspace/client isolation** — that's Phase 8.4's design doc.
- **No data leaves anywhere new.** Self-hosting remains the residency story:
  the operator picks the region, which is already a better answer than most
  SaaS competitors can give.

## Open questions (operator calls to make at build time)

1. **Default TTLs** — 90/365/730 proposed above; confirm against what UK
   agency DPAs actually ask for before hardcoding defaults.
2. **Suppression hashing** — hash-at-scrub (proposed) vs plaintext-forever;
   hashing costs a tiny check overhead and a salt-management story.
3. **Should consent also gate CAPI dispatch?** Meta receives hashed PII; in
   strict readings, dispatching an unconsented person's conversion is itself
   a disclosure. Proposal: in strict mode, dispatch only consented
   conversions (they're the only ones with click evidence to dispatch
   anyway — the forged-value and consent gates converge).
4. **Anonymization vs deletion for expired contacts** — anonymize-in-place
   (proposed, keeps reporting intact) vs hard-delete rows; some DPOs prefer
   deletion optics even at reporting cost. Could be a config flag if asked
   for; don't build until asked.
