# Boundary Revision Proposal

> **Superseded in part by [ADR 0001](./adr/0001-provider-boundary.md):** the
> deferred `@hogsend/plugin-resend` → `provider-resend` rename floated in "Move 2"
> below is **not** happening (packages keep their `plugin-*` names); ADR 0001
> instead relocates the capability-provider contracts (`EmailProvider`,
> `PostHogService`) into `@hogsend/core`, re-exported from `@hogsend/engine`.

**Status:** IMPLEMENTED. Option B (module augmentation) and the
`createContainer` → `createHogsendClient` rename were adopted; templates are now
client-owned content in `src/emails`, the provider is a dumb `EmailProvider`, and
`overrides` is split into a first-class grouped `email` ({ provider, templates }) + `analytics` args
plus a small advanced/test-only escape hatch.
**Prompted by:** the engine carve drew a few boundaries too tight. This walks
back the over-opinionated bits while keeping the upgrade path that the carve
bought us.

---

## The problem in one paragraph

The carve gave us a versioned `@hogsend/engine` and a thin content-only app — a
real win for upgrades. But three boundaries ended up on the wrong side of the
"content vs. framework" line, and the symptom is the same every time: things a
normal user *wants to edit* live inside a package, so editing them means
"ejecting" — a concept newcomers don't have. The fix is not to add more escape
hatches; it's to **move the edit-me stuff back into the user's repo** so eject
becomes the rare power move it should be.

The annotated scaffold (`examples/my-first-hogsend/`) independently surfaced the
same two complaints: "there's no `emails/` folder to edit" and "`overrides` is an
unexplained test-only seam." This proposal is the design response.

## The principle (the rule we apply everywhere)

> **If a typical product team will edit it to ship their product, it is content
> and lives in their repo. If they only edit it to change how the framework
> behaves, it is engine.**

Journeys, webhook sources, and constants already pass this test (they're in
`src/`). Email templates fail it today (they're in a package). The email
*provider* is borderline and we'll resolve it explicitly below.

---

## Move 1 — Email templates become content

### Problem (with evidence)

- The 16 templates and their registry are hardcoded in `@hogsend/email`
  (`packages/email/src/registry.ts:25` `defaultRegistry`, plus 16 `.tsx` files).
- `createEmailService` always renders against that baked registry — it never
  threads a caller-supplied one (`packages/plugin-resend/src/service.ts:90,153`
  call `getTemplate({ key, props })` with no `registry`).
- Result: to change what the welcome email *looks like*, you edit a file inside
  `node_modules`/a package — i.e. you eject on day one. The scaffold has no
  `emails/` folder at all, which every newcomer expects.

### End state

```
your-app/
└── src/
    └── emails/                  # YOU OWN THESE — scaffolded in, edit freely
        ├── welcome.tsx
        ├── activation-nudge.tsx
        ├── registry.ts          # maps keys → component + subject + category
        └── index.ts
```

- `@hogsend/email` keeps only the **machinery**: `renderToHtml`,
  `renderToPlainText`, `createRegistry`, `getTemplate`, the `TemplateRegistry`/
  `TemplateDefinition` types, a base layout + shared components, and the
  unsubscribe token/URL helpers. No concrete business templates baked in.
- `create-hogsend` copies a starter set of `.tsx` templates + a `registry.ts`
  into `src/emails/` (same model as the 10 example journeys: a starting point,
  yours to delete/rewrite).
- The client's registry is **injected** into the container (see Move 3 naming),
  and threaded into `getTemplate(..., { registry })` at send + render time.

### The hard part — type safety (NEEDS YOUR DECISION)

The runtime change is easy (thread the registry through; the param already
exists). The *type* coupling is the real work: `TemplateName = keyof
TemplateMap` is a closed union in the package, so a client key like
`"my-custom"` won't type-check today. Three ways out:

| Option | What it is | Type safety | Ceremony |
|---|---|---|---|
| **A. String keys** | `template: string`, `props: Record<string, unknown>` | none (no key↔props checking) | zero |
| **B. Module augmentation** *(recommended)* | client augments an empty `interface TemplateRegistryMap {}`; `TemplateName = keyof TemplateRegistryMap` | full | one scaffolded `.d.ts`-style augmentation file |
| **C. Generics threaded** | `createContainer<T>` … `sendEmail<T>` carry the map | full | invasive — every layer becomes generic |

Recommendation: **B**. It's the standard "plugin augments host types" pattern
(how Hono/Fastify type env + variables), keeps `sendEmail({ template, props })`
fully checked, and the only cost is `create-hogsend` scaffolding one
augmentation file alongside `src/emails/registry.ts`. **A** is the pragmatic
fallback if B's scaffolding proves fiddly, at the cost of Hogsend's typed ethos.
**C** is not worth the blast radius.

### Migration impact

- `apps/api` (our own dogfood app) gains a `src/emails/` dir; the 16 templates
  move out of `packages/email`.
- `create-hogsend/template` gains `src/emails/` + the augmentation file.
- `@hogsend/email` ships a `templates/` example dir for the scaffolder to copy,
  not as the runtime source.

---

## Move 2 — The email provider shrinks to a thin adapter; tracking stays engine-owned

### The decision you floated, and why I'd invert it

You wondered whether all the tracking should move *into* the Resend plugin.
I'd push back and do the opposite, for one concrete reason: **tracking is not a
Resend concern.** Link rewriting, the open pixel, the `/v1/t/c` + `/v1/t/o`
redirect routes, and the `tracked_links` / `email_sends` tables are
provider-agnostic. If they lived in `plugin-resend`, then (a) the provider
package would own DB tables and HTTP routes, and (b) the day you swap Resend for
Postmark you'd *lose all click/open tracking* and have to reimplement it.

So the cleaner version of your instinct is the inversion: **the engine owns a
`TrackedMailer`; the provider implements only a dumb `EmailProvider`.**

### End state

```ts
// The entire provider contract. Resend, Postmark, SES — implement this.
interface EmailProvider {
  send(msg: {
    from: string; to: string; subject: string;
    html: string; text?: string; headers?: Record<string, string>;
  }): Promise<{ id: string }>;
  // provider-specific delivery events
  parseWebhook(req): WebhookEvent | null;
  verifyWebhook(req): boolean;
}
```

The engine's `TrackedMailer` (moved out of `plugin-resend/service.ts` into the
engine) does everything else, in order:

1. render template (via `@hogsend/email` + the client's registry — Move 1)
2. check email preferences / suppression
3. `prepareTrackedHtml` — rewrite links + inject pixel (already engine code)
4. insert the `email_sends` row
5. call `provider.send(...)`  ← the only swappable bit
6. record `resendId` / status

`@hogsend/plugin-resend` shrinks to ~a provider + webhook parser. Swapping
providers is then exactly the "implement `send(html)`" story I promised earlier —
tracking, DB, preferences, and rendering all come along for free because they
never lived in the provider.

> Optional: rename `@hogsend/plugin-resend` → `@hogsend/provider-resend` to
> signal the shrink. Cosmetic; can defer.

### Migration impact

- `createEmailService` logic relocates from `plugin-resend` into the engine as
  `createTrackedMailer`. `plugin-resend` keeps `createResendClient`, `send`,
  `sendBatch`, and the webhook parse/verify — re-expressed as an `EmailProvider`.
- The engine container builds the mailer itself instead of importing the whole
  service from the provider plugin.

---

## Move 3 — Split `overrides` into first-class args + a small escape hatch

### Problem

`overrides: { emailService, posthog, auth, hatchet }` lumps two very different
things together: things users *legitimately supply* (their email provider, their
analytics) and *test-only seams* (mock auth/hatchet). "Override" signals "you're
fighting the framework," which is wrong for the common case. The scaffold note
called it out as "exposed in the type but unused and unexplained."

### End state

```ts
createContainer({
  journeys,
  templates,                 // ← first-class (Move 1): your template registry
  provider,                 // ← first-class (Move 2): your email provider
  analytics,                 // ← first-class: PostHog or your own (default: PostHog)
  overrides: {               // ← genuinely advanced / test-only, documented as such
    auth, hatchet, mailer, db,
  },
});
```

Common config reads like configuration; the escape hatch stays small and is
clearly labelled "you probably don't need this." `analytics` is the seam name
for the abstraction; PostHog remains the default implementation.

### Migration impact

- Pure additive + rename at the call site. `apps/api` and the scaffold pass
  `email` (provider + templates) explicitly; tests keep using `overrides`.

---

## Move 4 — `createContainer` clarity (small)

Not a structural change — a documentation + naming pass. The walkthrough's plain
definition is the model: "called once per process, returns one bag of shared
services so routes and journeys reach the same db/auth/email instead of each
newing up their own." Options: keep the name and document it hard, or rename to
something less DI-jargon-y (`wireServices` / `createServices`). Low stakes;
recommend **keep + document** unless you feel strongly.

Also fold in the **scaffold bug** the walkthrough found while we're here:
`src/workflows/` is dead-wired — `worker.ts` never passes workflows, and
`backfill-example.ts`'s comment says `workflows` when the real option is
`extraWorkflows`. Fix the comment and wire one example via `extraWorkflows` in
the template so custom tasks actually register.

---

## What this does to "eject"

Today eject is something you hit on day one (to edit a template). After Moves
1–3, everything a normal team edits — journeys, templates, provider choice,
analytics, schema, webhook sources — lives in their repo as first-class content.
Eject drops back to what it should be: a rare move to fork an *engine internal*
(a route, a middleware, the ingestion pipeline). We recover most of the old
"fork it and it's all mine" feeling **and** keep the upgrade path. That's the
whole point.

---

## Explicit non-goals (so we don't over-correct)

- **Tracking does NOT move into the provider plugin** — it moves the other way
  (Move 2). Stated explicitly because it's the opposite of one option floated.
- We are **not** going back to the fork model. The engine stays a versioned dep.
- We are **not** touching the journey runtime, ingestion pipeline, two-track
  migrations, or the admin/API surface — those boundaries are correct.

---

## Suggested sequencing

1. **Scaffold bug fix** (Move 4 tail) — tiny, independent, ship anytime.
2. **Move 3** (overrides split) — additive, unblocks the call-site shape Moves
   1–2 need.
3. **Move 2** (provider inversion) — relocate the mailer into the engine.
4. **Move 1** (templates out) — depends on the registry-injection seam from
   Moves 2–3; includes the type-safety decision (A/B/C).
5. Update `create-hogsend/template`, `apps/api`, docs, and the example app to
   match; re-run the smoke test end-to-end.

Each step keeps tests green; Moves 1–2 are the only ones that touch package
boundaries and should each land with the full smoke run.

---

## The one decision I need from you

**Template type safety: A, B, or C?** (recommended **B** — module augmentation.)
Everything else here I can spec into a phase plan and execute; this one changes
how much of the work is type-system plumbing vs. straightforward file moves.
