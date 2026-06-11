---
name: hogsend-authoring-emails
description: Use when adding or editing a transactional email in src/emails/ — creating a react-email .tsx, keeping the four-file contract (component, types.ts props, registry.ts entry, templates.d.ts augmentation) in sync with the Templates constant key, sharing _components, plaintext/preview, and how link-click + open tracking and unsubscribe are applied automatically on send.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Hogsend emails

A Hogsend email is a [react-email](https://react.email) component plus three
small sidecar declarations that make it sendable and type-checked. You author
them in your app's `src/emails/`; `@hogsend/email` is render machinery only — it
bakes in no concrete templates. You call the engine factories and import from
`@hogsend/engine` / `@hogsend/email`; you never edit engine internals.

The send pipeline is engine-owned: the same `createTrackedMailer` that renders
your template also rewrites every link for click tracking, injects an open
pixel, runs preference/suppression checks, and writes the `email_sends` row —
automatically, before the email reaches the provider. That is why tracking and
unsubscribe live in THIS skill, not a separate one: you get them for free on
every send, and what you author in `src/emails/` only has to leave room for them
(an `unsubscribeUrl` slot in the footer).

## The five touch points that must agree

Every template is really FIVE coordinated edits keyed on one string:

1. `src/emails/<name>.tsx` — the react-email component (default export).
2. `src/emails/types.ts` — its `Props` interface.
3. `src/emails/registry.ts` — a `templates[key]` entry (component + subject).
4. `src/emails/templates.d.ts` — augments `TemplateRegistryMap` so `key → Props`.
5. `src/journeys/constants/index.ts` — the `Templates.*` constant journeys send.

If the key in (3), (4), and (5) drifts, or the `Props` in (2)/(4) disagree, you
get a type error at the send call site — the #1 trap. See
`references/template-four-file-contract.md`.

## Key concepts

- **Registry is wired once.** `src/emails/index.ts` exports `templates`;
  `src/index.ts` passes it as `createHogsendClient({ email: { templates } })`.
  You only edit `src/emails/`; the wiring already exists.
- **Shared chrome lives in `src/emails/_components/`** — `Layout` (preview +
  card + footer), `ui` primitives (`Title`/`Body`/`Button`/`Callout`/…), `Logo`,
  `Footer`. Compose these instead of raw HTML.
- **Subject + preview + category** are declared on the registry entry, not in the
  component. `defaultSubject` is the fallback subject; `preview` is the inbox
  snippet; `category` drives frequency-cap exemption (`transactional` is exempt).
- **Tracking + unsubscribe are automatic on `emailService.send` / `sendEmail`.**
  You never call `prepareTrackedHtml` or `generateUnsubscribeUrl` yourself.
- **Semantic links (`EmailAction` from `@hogsend/email`)** make a click MEAN
  something: an anchor that fires a real event (`event` + scalar `properties`)
  through the full ingest pipeline — in-email yes/no questions, NPS scores,
  one-tap choices. First answer per (send, event name) wins; scanner
  click-bursts are suppressed. Details + rules in
  `references/tracking-and-unsubscribe.md`.

## Task playbooks — load the matching reference

- **Add or rename a template and keep all five touch points in sync (and read
  the type-error trap)** → `references/template-four-file-contract.md`
- **Build the component itself: shared `_components`, props typing, preview /
  category / defaultSubject, plaintext** → `references/email-components.md`
- **Render or preview a template, and how the consumer registry is built /
  threaded** → `references/preview-and-render.md`
- **What happens automatically on send: link-click + open tracking, the
  `/v1/t/*` endpoints, the unsubscribe token/URL + preference checks** →
  `references/tracking-and-unsubscribe.md`

To send a template from inside a lifecycle flow, see the
**hogsend-authoring-journeys** skill. To inspect a send / open / click rate
against a live instance, see the **hogsend-cli** skill.
