# Consent & legal posture

> This is the load-bearing part of the feature. Sourcing a cold contact means creating a person who has given **no consent on any channel**. The engine must be safe-by-default and provably legal for cold email, while leaving a deliberate, logged path to loosen a channel later if the law or the relationship changes.
>
> **This document is not legal advice.** The defaults below are conservative engineering choices; the copy and any decision to open a non-email cold channel must be signed off by a human (an enumerated seam in the [execution plan](./execution-plan.md)).

## The rule, in one line

**Cold email flows by default; every other channel is fail-closed until the contact explicitly opts in.**

## Why cold email is allowed by default

Cold B2B email is lawful in the major regimes **provided the message identifies the sender and offers a working opt-out** — both of which the engine's tracked mailer already does on every send:

- **US — CAN-SPAM** is an *opt-out* regime: no prior consent required, but the message must not use deceptive headers, must identify itself, include a physical postal address, and honour unsubscribe promptly. The mailer's identification + one-click unsubscribe + suppression-on-opt-out satisfy this.
- **EU/UK — GDPR / PECR**: B2B outreach can rest on **legitimate interest** when it is relevant to the recipient's role and an easy opt-out is offered. (Corporate subscribers get more latitude than consumers; individual/sole-trader addresses are more sensitive.)

So **no new gate is needed to *send* cold email** — it already flows through the normal suppression path (blocked only on `unsubscribedAll` / explicit category opt-out / hard-bounce suppression). What we add is *provenance* so a cold contact is distinguishable, not a new email gate.

## Why SMS / voice / connectors are fail-closed

These are **not** cold channels:

- **US — TCPA** requires **prior express (written, for marketing) consent** before an autodialed/pre-recorded marketing SMS or call. There is no lawful "cold SMS" or "cold voice" for marketing.
- **Chat connectors (Discord/Telegram)** require the contact to have linked their account — which is itself an opt-in — so a cold prospect has no lawful surface there either.

Therefore these channels are things a contact **earns** by opting in during a journey (e.g. clicks a semantic link → confirms → the channel unlocks). They must be **fail-closed**: blocked unless the contact has *explicitly* opted in.

## How it's enforced in the engine

The machinery already exists — the work is to point it the right way for cold contacts.

1. **Channel polarity** (`packages/engine/src/lists/`). `ListRegistry.isSubscribed(categories, id)` treats `defaultOptIn:false` as **"subscribed only when the category is explicitly `true`"** — i.e. fail-closed. Cold channels (SMS/voice/connectors) are authored / synthesized with `defaultOptIn:false` via the new `coldChannels` config in `synthesizeChannelLists` (Phase 0.2). The default for existing channels stays `true`, so **nothing already shipped changes behaviour**.

2. **The send gate** (`checkActionAudience` in `packages/engine/src/lib/connector-actions.ts`). Today it fails **open** on an unresolved recipient (allows the send). For a **cold/sourced** contact on a non-email channel we flip it to fail **closed** (Phase 0.3): an unresolved ref or a not-explicitly-opted-in channel → **skip** (`channel_unsubscribed`). Non-cold contacts keep today's behaviour — no regression.

3. **Provenance** (`contacts.source` / `contacts.sourcedAt`, Phase 0.1) is what tells the gate a contact is cold. Absence of a `source` = a first-party contact = unchanged behaviour.

4. **Cold email** needs no gate change — it already sends unless suppressed, and the mailer already adds identification + unsubscribe.

## The "unflick" override (`coldPosture`)

Loosening is deliberate, explicit, per-source **and** per-channel, and **logged**.

```ts
defineContactSource({
  meta: { id: "clay", name: "Clay" },
  // Legal-safe defaults if omitted: { email: "allow", "*": "block" }.
  coldPosture: {
    email: "allow",      // cold email — lawful with identification + unsubscribe
    sms: "block",        // TCPA: needs prior express consent — keep blocked
    discord: "block",    // requires an account link (an opt-in) — keep blocked
    // To open a non-email channel you must set it explicitly to "allow".
  },
  // ...transform, writeBack
})
```

Rules:

- **Defaults are safe:** omit `coldPosture` and you get `email: "allow"`, everything else `block`.
- **Opening a non-email channel is a conscious act:** setting any non-email channel to `"allow"` emits a boot/log line recording the deliberate loosening (who/what source/which channel), so it is auditable.
- **It's reversible and granular:** flip one channel on one source without touching anything else. If the law changes (or you obtain consent through another lawful basis) you "unflick" exactly the channel you're cleared for.
- **A prospect always overrides upward on real opt-in:** once a contact explicitly opts in to a channel (sets its category `true`), the normal preference wins — `coldPosture` only governs the *cold, no-consent* default.

## Audit trail

Phase 5.2 adds a consent/provenance audit ledger: for each contact, where it was sourced, when, and every consent-state change. This is what makes the posture *provable* rather than merely configured — important if a recipient or regulator ever asks how a contact entered a channel.

## Human sign-off seams

- Final **cold-email copy** (identification block + unsubscribe wording) for each cold journey.
- Any decision to set a **non-email channel to `allow`** for cold contacts, per jurisdiction / relationship.
