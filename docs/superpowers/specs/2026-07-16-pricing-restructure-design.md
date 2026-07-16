# Pricing page restructure — design

Date: 2026-07-16
Scope: `apps/docs/app/(home)/pricing/page.tsx` copy + layout only. No API, Stripe, or `lib/pricing.ts` tier changes.

## Problem

The pricing page shows four equal-weight cards in a 2×2 grid (Self-hosted $0, Managed $149/mo, Setup week $2,300, Done-for-you $1,500/mo). It reads convoluted: the $0 card carries a 16-item checklist so the cards are enormous and uneven, the accent sits on the $0 card, and the setup week — the weakest offer — has the same weight as done-for-you, which is the offer Doug actually wants to sell.

## Decisions (confirmed with Doug)

1. **Fold setup week into done-for-you.** Three tiers remain. Month one of DFY IS the install, plus founder involvement and a PostHog account analysis. Setup week survives only as a footnote + FAQ entry, both still linking to the live $2,300 Stripe checkout.
2. **Layout: single 3-card row** (`md:grid-cols-3`, stacked on mobile), done-for-you highlighted. No carousel.
3. **Card density: ~5–6 bullets each, equal height.** The full 16-item $0 list moves to a compact "everything in the box" strip below the row.
4. **DFY terms unchanged:** $1,500/mo, 3-month minimum, "Book a call" CTA. Only the copy gets richer.
5. **Setup checkout stays alive** — `lib/pricing.ts` keeps the `setup` tier; nothing unwinds on the dogfood API side.

## The tier row

Three equal-height cards:

### 1. Self-hosted — $0 /forever
- Loses the accent border and bottom glow (accent moves to DFY).
- ~5 bullets: the engine and all packages; 10 production journeys in the scaffold; durable execution (Hatchet); first-party open & link tracking; every future version (`pnpm up "@hogsend/*"`).
- CTA: **Start building** → `/docs/getting-started`.
- Micro-label: unchanged spirit ("Software: $0 · every release included").

### 2. Managed instance — $149 /per month
- ~5 bullets: your own single-tenant instance in its own Railway project; upgrades applied as they ship; monitored and kept healthy; infrastructure cost included; the Railway project is yours — take it over or cancel anytime.
- CTA: **Get the managed instance** — existing `CheckoutCta tier="managed"`, unchanged.
- Keeps the Loops $249-at-50k comparison line if it fits cleanly; drop if it breaks equal height.

### 3. Done-for-you lifecycle — $1,500 /per month  ← highlighted
- Accent border + bottom radial glow + accent TagPill (register: founder-led, e.g. "Founder-led" / "Install + operate").
- Copy themes (final wording shown in chat before editing, per copy-register rule):
  - Three-month commitment to getting lifecycle to market.
  - Month one is the full install — everything the setup week did (deploy, PostHog wired, provider + domain auth, templates ported, first journeys live in your repo).
  - Doug — founding growth engineer — working closely with you, on Hogsend and on your PostHog.
  - A PostHog account analysis / report, and the program built on it.
  - New journeys and experiments as the product and funnel change; a weekly report.
- CTA: **Book a call** → `/service#enquire`, unchanged.
- Footnote directly under the card: "Just want the install? The setup week is $2,300 one-time" → `CheckoutCta tier="setup"` as a text-level link/button.

Section heading subtitle rewritten for three tiers (current copy references "the other three cards").

## Below the row: "everything in the box" strip

The full ZERO_DOLLAR_ITEMS list (16 items) rendered as a compact 2–3-column checklist grid in its own sub-section beneath the tier row, framed as what $0 — and therefore every tier — includes. Nothing from the current list is deleted.

## Unchanged sections

Real costs, pricing calculator, comparison table, license, closing CTA — untouched. FAQ entries reworded where they reference the four-card structure ("Can someone set Hogsend up for me?" now leads with DFY, setup week second; managed answer's "the setup week and the done-for-you plan" phrasing adjusted). FAQ JSON-LD keeps mirroring the visible copy via the shared constant.

## Testing / verification

- `pnpm --filter docs build` (or the repo's docs check) + `pnpm check-types` + `pnpm lint`.
- Live preview (local run + screenshot, real components — no mockups) shown BEFORE merge, per standing feedback.
- Verify the setup-week checkout link still initiates Stripe checkout from the footnote.

## Out of scope

- `/service` page rewrite (follow-up).
- Any change to Stripe products, dogfood API `POST /checkout`, or tier ids.
