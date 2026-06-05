# ADR 0001 — The Provider Boundary: capability providers vs. integrations

> **Status:** ACCEPTED (scoped) — 2026-06-05. See **Decision (2026-06-05)** below
> for what is being done now vs. deferred; the "Open decisions" at the end are
> resolved in line with it.
> **Supersedes:** the deferred "Move 2" rename thread in
> [boundary-revision-proposal.md](../boundary-revision-proposal.md) (which shrank
> the provider to a dumb `EmailProvider` but left contract *ownership* and the
> word "plugin" unresolved).
> **Builds on:** the content-vs-framework principle in
> [boundary-revision-proposal.md](../boundary-revision-proposal.md) and the locked
> decisions in [engine-boundary.md](../engine-boundary.md) (esp. **D5**, marked
> *revisit post-1.0*).
>
> First entry in `docs/adr/`. Future architecture decisions are numbered ADRs here.

---

## Decision (2026-06-05)

Accepted **scoped**: fix ownership now, neutralize shapes later.

**DOING NOW**

- **Move 1 (relocation only, no shape change/rename).** Move the capability
  contracts (`EmailProvider`, `SendEmailOptions`, `BatchEmailItem`, `SendResult`,
  `WebhookEvent`; `PostHogService`) to `@hogsend/core`, re-exported from the
  vendor plugins for back-compat and from `@hogsend/engine` as the canonical
  author import. The shapes are relocated verbatim — **no neutralizing, no
  rename** in this pass.
- **The two injection bug fixes (Move 4).** Make the injected `analytics`
  honored everywhere — journey context `capture`/`identify`, the bucket→PostHog
  sync, and worker shutdown read `container.analytics`, not the `getPostHog()`
  singleton. And route the two outbound paths (`workflows/send-email.ts`,
  `lib/notifications.ts`) through the injected provider/mailer instead of
  `createResendClient` directly.
- **Stale-docs cleanup.** Fix the flat-shape `createHogsendClient` examples to the
  implemented `email: { provider, templates }` grouping (this doc set).

**DEFERRED until Postmark lands** (we design a good neutral contract against two
real implementations, not one):

- Neutralizing the `WebhookEvent` shape **and** the `AnalyticsProvider`
  rename/optional-method surface (**Move 3**).
- Breaking the engine's hard vendor dependency / dropping the baked-in Resend
  default (**Move 2**).
- The capability-neutral webhook route + `providerMessageId` column (**Move 5**).
- The `create-hogsend` provider prompt / scaffold wiring (**Move 6** scaffold
  portion).
- The package renames (**Move 7**).

**Implementation note (found during the Move 1 pass).** `@hogsend/engine` already
exports a *different*, journey-facing `SendEmailOptions` (the high-level
`sendEmail()` helper shape), so the provider-contract `SendEmailOptions` is **not**
re-exported from `@hogsend/engine` — it stays reachable from `@hogsend/core` /
`@hogsend/plugin-resend` — to avoid a duplicate-export collision (TS2308). Resolve
the clash when neutralizing shapes (**Move 3**), e.g. rename the contract type
(`ProviderSendOptions`) so a provider author gets the whole contract from one
`@hogsend/engine` import.

**RATIONALE.** The structural error is contract *ownership* (the abstraction
depending on its own implementation) — fix that now, cheaply, with a pure
relocation plus the two real injection bugs. Shape neutralization is the
expensive, judgement-heavy part: you design a good neutral contract against a
second implementation, not against one. So we move ownership today and neutralize
shapes when Postmark gives us the second data point.

---

## The problem in one paragraph

A customer asked for Postmark. We "support" swapping the email provider, and the
analytics backend, via `createHogsendClient`. But chasing that thread exposed
that **the abstraction depends on its own implementation**: the `EmailProvider`
contract a Postmark author must implement lives *inside* `@hogsend/plugin-resend`
(`packages/plugin-resend/src/types.ts`), so building the thing that *replaces*
Resend means importing the Resend package. The same is true for analytics
(`PostHogService` lives in `@hogsend/plugin-posthog`). And the word **"plugin"**
is doing two incompatible jobs at once — it labels both a *swappable capability
contract* (email) and a *service the engine just calls* (analytics) — while the
docs simultaneously insist "there is no plugin framework." The boundary is in the
wrong place, and the vocabulary hides it.

## The evidence (grounded)

1. **The abstraction depends on the concrete.** `EmailProvider` and its
   supporting types (`SendEmailOptions`, `SendResult`, `WebhookEvent`) are defined
   in `@hogsend/plugin-resend`; `PostHogService` is defined in
   `@hogsend/plugin-posthog`. The engine imports both **as types from the vendor
   packages** and re-exports *neither* from `@hogsend/engine`. A provider author
   has no neutral contract to implement against.

2. **The engine hard-depends on every vendor.** Both `@hogsend/plugin-resend` and
   `@hogsend/plugin-posthog` are `dependencies` (not peer/optional) of
   `@hogsend/engine`. A Postmark-only shop still bundles `resend` **and** `svix`
   transitively, forever.

3. **The analytics "swap" is only half-wired.** `opts.analytics` is honored only
   by the two HTTP tracking routes (`routes/tracking/open.ts`, `click.ts`). The
   journey-context `capture`/`identify` (`journeys/define-journey.ts`), the
   bucket→PostHog sync (`lib/bucket-posthog-sync.ts`), and worker shutdown
   (`worker.ts`) all bypass the injected instance and call the module singleton
   `getPostHog()` directly. You cannot actually replace analytics today and have
   it take effect everywhere.

4. **Two outbound paths bypass the provider contract entirely.**
   `workflows/send-email.ts` and `lib/notifications.ts` import `createResendClient`
   directly and read `process.env.RESEND_*` — a swapped provider is not honored
   there at all.

5. **The inbound webhook route is vendor-hardcoded.** Email delivery webhooks land
   at `POST /v1/webhooks/resend` (`routes/webhooks/resend.ts`), and the provider
   message id is stored in a column literally named `resendId`. A Postmark webhook
   would POST to a path named "resend" and write its `MessageID` into `resendId`.

6. **"Plugin" is a filename prefix, not a concept.** No registry, no `plugins: []`,
   no discovery. `guides/plugins.mdx` states outright: *"There is no plugin
   framework… no plugin registration, no lifecycle hooks, nothing to inject."* The
   two `plugin-*` packages aren't the same kind of object.

7. **The docs have already drifted.** Both `customizing-the-engine.md` and
   `engine-boundary.md` still show `provider?` / `analytics?` as **top-level**
   options, but the implemented shape nests the provider under
   `email: { provider, templates }`. `guides/email.mdx`'s "Swapping the provider"
   example uses that same stale flat shape — which silently no-ops and falls back
   to default Resend.

## The principle (a second axis, added to the existing one)

`boundary-revision-proposal.md` gave us the **content vs. framework** axis (*who
edits it* decides where it lives). That axis is correct and unchanged. This ADR
adds the axis it didn't cover — **what kind of extension is it** — and the rule
that resolves the Postmark question:

> **A capability provider is a swappable implementation of an engine-owned
> contract. The contract is owned by the engine side and lives in a neutral
> package; the vendor implementation depends on the contract, never the reverse.
> An integration is a one-directional call out to a service; it is "just code"
> and needs no contract at all.**

This splits today's overloaded "plugin" into two clearly-named things:

| | **Capability provider** | **Integration** |
|---|---|---|
| What it is | A swap point the engine routes *to* (and receives webhooks *from*) | A function a journey calls *out* to |
| Examples | email (Resend, Postmark, SES), analytics/CDP (PostHog, Segment) | Slack ping, CRM upsert, Stripe call |
| Contract | A named interface **owned by `@hogsend/core`** | None — a plain typed function |
| Direction | Bidirectional (send + inbound webhook) | Outbound, fire-and-forget |
| How you add one | `npm install @hogsend/provider-x` + register in one slot | Write `src/lib/x.ts`, import it in a journey |
| Today's status | Misplaced (contract in vendor pkg, half-wired) | **Correct already** — keep as-is |

The current `plugins.mdx` philosophy ("just well-organized code, no framework") is
**right for the Integration column and wrong for the Capability column.** Email
and analytics are not "just imports"; they are contracts. Naming the two apart is
the whole fix — everything below follows from it.

Precedent: this is the model of **Better Auth** (which the engine already depends
on) — `BetterAuthPlugin` in core, providers as installable packages, registered in
a `plugins: []` array. Auth.js (`providers: [GitHub()]`) and Drizzle dialects are
the same shape. The universal rule is *contract-in-core → thin vendor package
depends on core → registered in one obvious slot.* We have the slot; we're missing
the first two.

---

## Move 1 — Relocate the capability contracts to a neutral home

**Decision:** the capability contracts move to `@hogsend/core` (already the
neutral leaf — it exports conditions, schemas, types, and depends on no vendor).

- `EmailProvider`, `SendEmailOptions`, `BatchEmailItem`, `SendResult`, and the
  normalized `WebhookEvent` union move from `@hogsend/plugin-resend` → `@hogsend/core`.
- `AnalyticsProvider` (renamed from `PostHogService`, see Move 3) moves from
  `@hogsend/plugin-posthog` → `@hogsend/core`.
- `@hogsend/engine` **re-exports** all of them from its public surface, so the
  canonical author experience is a single import:

```ts
import type { EmailProvider, AnalyticsProvider, WebhookEvent } from "@hogsend/engine";
```

Why core and not engine itself: the vendor packages must import the contract to
implement it, and the engine wants to ship a default that depends on a vendor —
putting the contract in the engine would make `engine → vendor → engine` circular.
Core is the leaf both sides can depend on without a cycle.

---

## Move 2 — Break the engine's hard dependency on vendors

Today `container.ts` bakes in `createResendProvider(...)` and `getPostHog()` as
defaults, which forces `@hogsend/plugin-resend` + `@hogsend/plugin-posthog`
(and `resend` + `svix`) into every install.

**Decision (recommended):** the engine depends on **`@hogsend/core` only** for
provider types and ships **no baked-in vendor default**. A provider is wired
explicitly; the scaffold pre-wires Resend so newcomer DX is unchanged:

```ts
// scaffolded src/index.ts — the default a fresh app gets
createHogsendClient({
  journeys, buckets,
  email: { templates, provider: resend({ apiKey: env.RESEND_API_KEY }) },
  analytics: posthog({ apiKey: env.POSTHOG_API_KEY }),
});
```

This is the Auth.js stance ("you choose your provider") and it removes the
transitive-bloat problem cleanly. **The cost:** a bare `createHogsendClient()`
with no provider no longer silently sends email — it's now an explicit, typed
requirement. See Open Decision **A** for the back-compat-preserving alternative
(keep a lazy default via an optional peer dep).

---

## Move 3 — Neutralize the contracts

- **Email:** `EmailProvider`'s *method* surface is already vendor-neutral
  (`send`/`sendBatch`/`verifyWebhook`/`parseWebhook`). The leak is the
  **`WebhookEvent` shape**, which is Resend's wire format verbatim
  (`data.email_id`, `data.bounce.{message,type}`, Svix-style fields). Redefine it
  in core as a **normalized delivery event** — `{ type: "delivered" | "bounced" |
  "complained" | "opened" | "clicked" | …, messageId, recipient, reason?, … }` —
  so each provider's `verifyWebhook`/`parseWebhook` normalizes *into* a neutral
  shape instead of every provider having to emit "Resend's event."

- **Analytics:** rename `PostHogService` → `AnalyticsProvider`. `capture`,
  `identify`, and `shutdown` are universal. **Be honest:** `getPersonProperties`
  and `isFeatureEnabled` are genuinely PostHog-leaning capabilities (person
  property store + feature flags) — not every CDP has them. Treat them as
  *optional capability methods* on the contract (a provider may omit feature
  flags), rather than pretending analytics neutralizes as cleanly as email. This
  is the one contract where the abstraction is real but lossy, and the ADR should
  not oversell it.

---

## Move 4 — Make the analytics injection actually load-bearing

Fix evidence-point #3: route every analytics call site through the
container-built instance, the way email already does (`setEmailService` feeds the
same instance the container built). Concretely, `JourneyContext`, the
bucket→PostHog sync, and worker shutdown must read the injected
`container.analytics`, not the `getPostHog()` module singleton. After this, an
injected mock or alternate CDP takes effect everywhere — and `overrides` gains an
`analytics` seam for parity with `mailer`.

Also fold in evidence-point #4: route `workflows/send-email.ts` and
`lib/notifications.ts` through the injected provider/mailer instead of
`createResendClient` directly, so no outbound path bypasses the contract.

---

## Move 5 — Capability-neutral webhook routing + neutral message id

- Replace the hardcoded `POST /v1/webhooks/resend` with a capability-neutral
  inbound path, **`POST /v1/webhooks/email`** (there is only ever one active email
  provider per app; its `verifyWebhook` already encapsulates the vendor specifics).
  Keep `/v1/webhooks/resend` as a deprecated alias for one minor version.
- Rename the `email_sends.resendId` column to a neutral `providerMessageId`
  (engine-track migration; keep `resendId` as a read alias through one release).

---

## Move 6 — Discoverability (the answer to "how do they even know to build it?")

The boundary fix is wasted if nobody can find the contract. Minimum bar:

- The contract re-exported from `@hogsend/engine` (Move 1) so it's one import away.
- `guides/providers.mdx` (rename/refocus today's `plugins.mdx`) that **names the
  two categories**, prints the `EmailProvider` interface, and explicitly labels
  `@hogsend/provider-resend` as *"the reference implementation — copy this to build
  a new provider."*
- Fix the stale flat-shape examples (evidence #7) while we're in those docs.
- **Deferred (non-goal for now):** a `create-hogsend-provider` scaffold and a
  "Providers" registry/marketplace page. That's the ecosystem layer; revisit once
  there's a second real provider in the wild.

---

## Move 7 — Package renames (OPTIONAL, deferred, decoupled)

`boundary-revision-proposal.md` already floated `plugin-resend` → `provider-resend`
and called it "cosmetic; can defer." Nothing in Moves 1–6 *requires* a rename — the
contract can move to core while the package keeps its current name. When we do
rename, capability-first names read best for discovery:

- `@hogsend/provider-resend`, `@hogsend/provider-postmark` (email)
- `@hogsend/provider-posthog` (analytics)

This is the **highest-cost, lowest-urgency** piece: npm rename + deprecate-alias +
scaffold update + version-line discipline, and the new package's *first* publish
must be manual (CI's `NPM_TOKEN` cannot create a brand-new `@hogsend/*` package).
Do it last, or never.

---

## What this does to the Postmark story

After Moves 1–3, Postmark is a thin package that depends on `@hogsend/core` for the
contract — **not** on the Resend package — and drops into the same slot:

```ts
import { postmark } from "@hogsend/provider-postmark";
createHogsendClient({ email: { templates, provider: postmark({ serverToken }) } });
```

Tracking, rendering, preferences, the `email_sends` lifecycle, and the inbound
webhook pipeline all come along for free, and the provider author implements four
methods against a contract they found in one obvious place. (The Postmark-specific
implementation notes — React→HTML rendering on the provider, no Svix signature,
`RecordType` normalization, no `email.sent`, singular `Tag`, 500-item batches —
are captured separately and unaffected by this ADR.)

---

## Explicit non-goals (so we don't over-correct)

- **No plugin framework for the Integration column.** Slack/CRM/Stripe stay plain
  imports. No registry, no lifecycle hooks, no manifest, no `ENABLED_PLUGINS`. The
  code-first wedge depends on *not* building this.
- **No marketplace yet.** Discoverability = an owned contract + a labeled reference
  impl + docs. The registry/scaffold ecosystem layer is deferred (Move 6).
- **Resend stays the default implementation** — we're moving where the *contract*
  lives and how the default is *wired*, not dropping Resend.
- **Not touching** the journey runtime, ingestion pipeline, two-track migrations,
  buckets, or the admin/API surface — those boundaries are correct.
- **Not re-litigating** content-vs-framework. Templates-as-content, the dumb
  provider, and the `overrides` split from `boundary-revision-proposal.md` stand.

---

## Suggested sequencing

Each step keeps tests green; the package-boundary moves each land with the full
smoke run.

1. **Move 1 + 3** — relocate + neutralize the contracts in `@hogsend/core`, engine
   re-exports them. Vendor packages now `import type … from "@hogsend/core"`.
   (No behavior change; pure type relocation.)
2. **Move 4** — make analytics injection load-bearing + close the two outbound
   bypass paths. (Bug fixes; independently valuable.)
3. **Move 2** — break the engine's hard vendor deps; scaffold wires the defaults.
   (The one behavior change — gated on Open Decision A.)
4. **Move 5** — neutral webhook route + `providerMessageId` column, with aliases.
5. **Move 6** — docs refocus + fix stale examples.
6. **Move 7** — package renames, only if we decide it's worth the publish cost.
7. *(separate effort)* — build `@hogsend/provider-postmark` against the now-neutral
   contract.

---

## Open decisions — resolved (2026-06-05)

**A. Default provider — break it or keep it lazy? → RESOLVED: keep the baked-in
Resend default for now.** Deferred alongside Move 2; the engine keeps its bundled
default and bare `createHogsendClient()` DX is unchanged. Revisit when Postmark
lands and we break the hard vendor dep. *(Original options: ship no vendor default
+ scaffold wires Resend explicitly, vs. keep a bundled/lazy default.)*

**B. Registration shape. → RESOLVED: keep the current per-capability keys.**
`email: { provider, templates }` nested, `analytics` top-level — asymmetric but
already implemented and documented as intentional. The load-bearing fixes are
contract location + honored injection, not the key shape; no unification under a
`providers: { email, analytics }` group.

**C. Analytics contract scope. → RESOLVED: defer analytics neutralization.** Keep
analytics PostHog-coupled for now (Move 1 relocates `PostHogService` to core
verbatim, no rename). The lossy `AnalyticsProvider` rename + optional-method
surface is part of the deferred Move 3, designed against a second backend later.

**D. Rename now or never (Move 7). → RESOLVED: defer.** No package renames in this
pass; Move 1 relocates the contract while the plugin packages keep their current
names (and re-export for back-compat).
