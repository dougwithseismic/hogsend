---
name: hogsend-authoring-flags
description: Use when adding or editing a code-first feature flag in src/flags/ — defineFlag({ key, name, type, variants?, defaultValue?, description?, enabled? }) from @hogsend/engine. A flag committed to the repo, upserted into a `flags` row by the boot reconciler (born DISABLED, rollout 0). Covers the contract-vs-state split (code owns key/name/type/variants/defaultValue/description; DB/Studio owns enabled/rollout/targeting/conditionSets), the register ritual (src/flags/index.ts + thread flags into createHogsendClient in BOTH src/index.ts and src/worker.ts), running `pnpm flags:generate` after adding/removing a flag to refresh flags.d.ts (typed useFlag/getFlag/evaluate), and when to use client.flags.create() / Studio (dynamic, experimental) vs defineFlag (durable product flags).
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Hogsend feature flags

A **feature flag** is a rule about a person that resolves to a value your app
reads — a boolean gate, or one arm of a multivariate set. `defineFlag()` commits
that flag's **contract** to the repo, mirroring `defineJourney()` /
`defineCampaign()` / `defineList()`: a synchronous, definition-time call that
validates the shape and returns a `DefinedFlag`.

You are editing a **scaffolded consumer app** (content only). You import
`defineFlag` from `@hogsend/engine`; the row lifecycle, the boot reconciler, the
evaluation engine, and the read routes are all engine-owned.

The headline fact: **a `defineFlag` definition is only HALF the flag.** Code owns
the flag's identity and served shape; the DB (via Studio or the admin API) owns
whether it is on and who gets it. The reconciler seeds the row, then leaves the
operator's state alone forever after.

## The contract / state split

| Owned by CODE (`defineFlag`) | Owned by the DB (Studio / admin API) |
|---|---|
| `key` — the stable identifier a client evaluates | `enabled` — the live master switch |
| `name` — human label | `rollout` — 0–100, the eligible share |
| `type` — `boolean` \| `multivariate` | `targeting` — property conditions |
| `variants` — the multivariate arms | `conditionSets` — richer targeting |
| `defaultValue` — served when off / miss | |
| `description` | |

`enabled` in a definition is a **one-time CREATE seed only** (default `false`).
A freshly-reconciled flag is born OFF with rollout 0, so shipping a flag file
never silently flips live traffic. An operator turns it on and dials the rollout
/ targeting in Studio; the reconciler honours `enabled` only on the INSERT and
never on a later contract sync. **Do not** put `targeting` or `rollout` in a
definition — they are not fields on `FlagDefineMeta`. Targeting is a live,
operator lever, not a committed one.

## The shape

```ts
import { defineFlag } from "@hogsend/engine";

// Boolean flag — a live-eval returns `true` only once an operator enables it
// AND the contact falls in the rollout slice.
export const previewBanner = defineFlag({
  key: "preview-banner",             // stable id — /^[a-z0-9_-]+$/i
  name: "Preview banner",            // human label
  type: "boolean",
  description: "Shows the in-progress preview banner.",
});

// Multivariate flag — `variants[].value` literals define the served-value
// union. `defaultValue` (default `null` for multivariate) is served on
// disabled / targeting-miss / outside-rollout.
export const ctaCopy = defineFlag({
  key: "cta-copy",
  name: "CTA copy",
  type: "multivariate",
  variants: [
    { key: "urgent", value: "urgent", weight: 1 },
    { key: "calm", value: "calm", weight: 1 },
  ],
  defaultValue: "calm",
});
```

`defineFlag({ key, name, type, variants?, defaultValue?, description?, enabled? })`
validates the contract at definition time and **throws** on a malformed
definition — so a bad flag fails fast at boot, not silently at eval time.

## Register ritual

1. Create the file in `src/flags/` (or add to `src/flags/index.ts` directly).
2. Export it from `src/flags/index.ts` and add it to the `flags` array.
3. The array is threaded into `createHogsendClient({ flags })` in BOTH
   `src/index.ts` and `src/worker.ts` (already wired in the scaffold). The
   registry-mirror rule applies: BOTH processes must register the same `flags`
   so each reconciles the same rows at boot. Flags are NOT passed to
   `createWorker` — only to the container.
4. Run `pnpm flags:generate` (see below) and commit the regenerated
   `src/flags/flags.d.ts`.

## Run `flags generate` after every add/remove

```bash
pnpm flags:generate     # → hogsend flags generate
```

This reads each flag's `meta`, infers its served **value type** (a boolean flag
→ `boolean`; a multivariate flag → the union of its `variants[].value` literals;
anything non-literal → `unknown`), and writes a
`declare module "@hogsend/core"` augmentation of `FlagRegistryMap` to
`src/flags/flags.d.ts`. It is deterministic and idempotent — safe to re-run and
commit.

That augmentation is what makes the read surfaces **type-check this app's keys**
and narrow their values:

- `useFlag("preview-banner")` / `useFlags()` (`@hogsend/react`)
- `hogsend.getFlag("cta-copy")` (`@hogsend/js`)
- `client.flags.evaluate({ userId })` (`@hogsend/client`)

A typo key becomes a compile error, and a boolean flag's value narrows to
`boolean`, a multivariate flag's to its literal union. **UNaugmented** (you never
ran the codegen), every surface degrades to today's `string`-key / `unknown`-value
shape — nothing breaks, you just lose the narrowing. So: forget to regenerate and
your new flag is still readable, just untyped. Regenerate to get the types back.

## Reading a flag

A flag resolves in one deterministic order (identical in the browser, on the
server, and in journey code): **disabled → default; targeting fails → default;
outside rollout → default; else** `true` (boolean) or a weight-picked arm
(multivariate). Membership is a stable hash of `(contact, key)`, so a contact's
answer is sticky with no stored assignment.

```tsx
// browser (React) — reactive, re-renders on identity change
import { useFlag } from "@hogsend/react";
const showBanner = useFlag("preview-banner"); // boolean | undefined
```

```ts
// server — one contact
const { flags } = await hogsend.flags.evaluate({ userId: "user_123" });
if (flags["preview-banner"]) { /* … */ }
```

In a journey, branch on the contact's properties as you already do — a flag is
the same property model the condition engine evaluates.

## `defineFlag` vs. `client.flags.create()` / Studio

- **`defineFlag()`** — the flag is CONTENT: reviewed in a PR, seeded by deploy,
  typed by codegen. Best for **durable product flags** — a gate you expect to
  live in the codebase, that other code reads by a typed key.
- **`client.flags.create()` (`POST /v1/flags`) or Studio → New flag** — the flag
  is created at run time by product code or an operator. Best for **dynamic /
  experimental / short-lived** flags: a quick kill-switch, an A/B you'll retire,
  a flag an operator needs without a deploy. Same evaluation engine, same read
  routes — it just isn't in `src/flags/` and isn't in `flags.d.ts` (reads are
  untyped `string`/`unknown` for it).

The two coexist: dynamic flags evaluate unchanged alongside code-defined ones.

## Gotchas

- The `key` is the reconcile identity. Renaming it mints a NEW flag (born off);
  the old row stays. Rename only if that is what you mean.
- `enabled: true` in a definition only fires on the FIRST reconcile (the INSERT).
  Flipping it in code later does nothing — an operator owns the switch after
  create. To turn a flag on, use Studio / the admin API.
- Never author `targeting` / `rollout` in code — they aren't definition fields
  and would be ignored. They are live operator state.
- Regenerate `flags.d.ts` (`pnpm flags:generate`) on every add/remove/type
  change and commit it — a stale d.ts just means stale types, never a runtime
  bug.
