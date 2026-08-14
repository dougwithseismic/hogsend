# BACKLOG — account linking (`defineAccountLink`)

Ordered queue. Build top-down. See `DECISIONS.md` for locked global choices and the quality gates.

Branch `feat/account-links`, worktree `.claude/worktrees/account-links`, branched from `main` at
`a4bbec5a`. Publish mode: `local-commits-only`.

| # | PRD | Status | Depends on | Scope |
| --- | --- | --- | --- | --- |
| 01 | [Provider contract + presets](prds/01-provider-contract.md) | `[x]` | — | `@hogsend/core`: `defineAccountLink`, `LinkedIdentity`, `AccountLinkHooks`, `oauth2Link()`, `steamOpenIdLink()`. Types + pure functions, zero DB |
| 02 | [`linked_accounts` schema + migration](prds/02-schema.md) | `[x]` | — | `@hogsend/db`: the table, three partial-unique indexes, the version constraint. Additive |
| 03 | [Link store: versioning, locking, policy](prds/03-link-store.md) | `[x]` | 01, 02 | **The heart.** `linkAccount`/`unlinkAccount`/relink under an advisory lock, monotonic version, `multiple`/`onConflict` enforcement, hook invocation |
| 04 | [Merge + delete repointing](prds/04-merge-repoint.md) | `[x]` | 02, 03 | Add `linked_accounts` to the merge repoint list; handle the singleton-collision case explicitly; **unlink every live link inside `softDeleteContact`'s transaction** (DECISIONS §15.3) or an erased contact's links outlive it and lock the pair forever. `adoptOrphanHistory` is a PROVEN NO-OP (`contact_id` is NOT NULL), pinned by test, not a repoint site |
| 05 | [Container wiring + provider registry](prds/05-container-wiring.md) | `[x]` | 01 | `accountLinks: { providers, hooks }`, `client.accountLinkProviders`, env-driven config, boot validation |
| 06 | [Concrete providers: Steam + Twitch](prds/06-providers.md) | `[x]` | 01, 05 | The two built-in definitions. **Discord is deliberately OUT (DECISIONS §12)** — it already links via `plugin-discord` and a second writer on `contacts.discordId` is the drift risk. Steam is the bespoke OpenID 2.0 one: mandatory `check_authentication` round-trip posted to Steam's HARDCODED endpoint (never `openid.op_endpoint` from the callback), strict `claimed_id` parse, `return_to` echo check |
| 07 | [Hosted flow: state, start, callback](prds/07-hosted-flow.md) | `[x]` | 03, 05, 06 | `account_link` state purpose, PKCE, nonce burn, throttle, `beforeLink` veto, cold vs warm |
| 08 | [Outbound events + catalog sync](prds/08-outbound-events.md) | `[ ]` | 03 | The three events, full-state versioned payloads, dedupe keys, **three** hand-synced catalog copies. **T1-T3 SHIPPED** (`356ddd9a` catalog, `baa9c0c9` payload types, `2c07d292` emit helpers + merge/deletion legs). **Remaining: T4** (callback emits + the four `link_failed` reasons), **T4b** (fanout registration), **T5** (journey-plane re-ingest), **T6** (changesets) |
| 09 | [Data plane: `/v1/accounts/*`](prds/09-data-plane.md) | `[ ]` | 03, 05 | List, reverse lookup, unlink, insert-only import, mint-link, and the one userToken-gated `me` route. New `accounts` scope |
| 10 | [Hosted pages + branding](prds/10-hosted-pages.md) | `[ ]` | 07 | Generalize `ColdConnectBranding`; link/success/error pages; `postMessage` origin allowlist |
| 11 | [Player manage + revoke page](prds/11-manage-page.md) | `[ ]` | 09, 10 | `GET /v1/accounts/manage?token=`, a DEDICATED contact-id-keyed token (NOT the unsubscribe payload, which mandates an email Steam never yields), per-row revoke. The fallback surface; the in-app userToken revoke is primary (DECISIONS §14) |
| 12 | [Server SDK `accounts.*`](prds/12-server-sdk.md) | `[ ]` | 09 | `@hogsend/client` resource mirroring `groups.ts` |
| 13 | [Embed SDK: popup + postMessage](prds/13-embed-sdk.md) | `[ ]` | 09, 10 | `hogsend.linkAccount()` in `@hogsend/js`, `<LinkAccountButton>` in `@hogsend/react`, unstyled |
| 14 | [Token custody + property sync](prds/14-enrichment.md) | `[ ]` | 03, 06 | Sealed tokens, `refresh()`/`revoke()`, one Hatchet cron writing namespaced contact properties, `invalid_grant` handling. Field is `sync: { every, read }` — NOT `enrichment` (saturated term, see DECISIONS §10) |
| 15 | [Studio panel](prds/15-studio-panel.md) | `[ ]` | 03, 09 (row shape only) | Observe-only contact-detail panel + reverse lookup. **Needs its own `/v1/admin/accounts` router behind `requireAdmin`** — Studio is cookie-authed and cannot call the `hsk_`-scoped data plane. Mirrors `routes/admin/groups.ts`. No authoring UI |
| 16 | [Docs + dogfood wiring](prds/16-docs-and-dogfood.md) | `[ ]` | 07, 09, 13 | `docs/account-links.md`, the verbatim consumer upsert rule, and a real provider wired into `apps/api` |

## Wave 2 — the gates themselves (queued 2026-08-14)

Surfaced while building PRD 08. These are not account-link features; they are the reason a green
gate is not currently evidence. **They jump the queue** — every remaining PRD's Done-when names
`cd apps/api && pnpm test`, which cannot pass today, and one of the four gates does not execute at
all. Building 09 onward first would mean certifying each of them against instruments that do not read.

| # | PRD | Status | Depends on | Scope |
| --- | --- | --- | --- | --- |
| 17 | [health-activity asserts a coupling the route refuses](prds/17-health-activity-coupling.md) | `[ ]` | — | **P0, reproducible red on clean `main`.** The test requires numeric counts whenever the DB component is `up`; `routes/health.ts` degrades counts to null on a 1500ms deadline OR any throw, independently of that component. The route is right and the test forbids the feature. Fix the test, pin the degradation path so the relaxed assertion still bites |
| 18 | [global-count assertions under a shared Postgres](prds/18-global-count-assertions.md) | `[ ]` | — | **P0, a CLASS not an instance.** `contact-id-backfill` (apps/api), `ops-stats` + `publish-cli-auth` (apps/cloud) assert global counts while parallel files seed the same DB. Scope each to owned rows — never retry, never soften to `toBeGreaterThan(0)`, never serialise the suite |
| 19 | [two gates cannot fail, one cannot run](prds/19-unrunnable-quality-gates.md) | `[ ]` | 17, 18 | **P0.** `pnpm -C <dir> turbo run test` dies `EACCES` before running anything (no root `turbo` script) — and its error reads exactly like a failing suite. That is the ONE gate catching the `@hogsend/testing` import-time-env class. Plus `check-types` is vacuous yet still cited in Done-when lists |

## Legend

- `[ ]` not started
- `[~]` shipped to a seam — in-repo path complete and green, an external dependency enumerated
- `[x]` done

## Notes

**Staging.** PRDs 01 to 06 are the spine and are independently shippable: the contract, the schema,
the store, the merge fix, the wiring and the providers, with no public route surface yet. 07 to 09
open the flow and the data plane. 10 onward are surfaces on top.

**The known seam (PRD 07, 16).** Real credentials for **Twitch only**. Every provider gets a
deterministic Fake so the whole flow is testable end to end without them; the human ask is a Twitch
app client id + secret with the redirect URI registered against this deployment's `API_PUBLIC_URL`.
Build to the seam, mark `[~]`, keep going.

**Steam is NOT a seam.** "Sign in through Steam" is OpenID 2.0 — the relying party presents no
credential, so there is no app to register and no secret to obtain. The provider registers on a bare
deploy and links for real. `STEAM_WEB_API_KEY` is optional and widens the provider (persona name,
avatar, and the PRD 14 playtime sync); it is a hard requirement only inside PRD 14.

**Owed as a SEPARATE ticket, not this stack** (DECISIONS §16): delete the dead OTP machinery
(`lib/connector-link-codes.ts` and the `connector_link_codes` table, retired but still exported), and
make the cold-connect confirm page show WHICH account and WHICH email so consent is informed.

**Owed outside this stack.** File the Epic Games org application now — approval takes weeks and v2
is otherwise gated on it.
