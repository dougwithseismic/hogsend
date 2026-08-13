# PRD 16 — Docs + dogfood wiring

## Goal

Write `docs/account-links.md` in the house shape, stating the consumer upsert rule verbatim, the
three planes and what each is for, the env convention, and the per-provider OAuth app setup
including the exact redirect URI to register. Then prove the whole thing by wiring one real provider
into `apps/api` in both `index.ts` and `worker.ts`.

## Locked decisions specific to this PRD

- **The documented customer rule, stated verbatim in docs** (DECISIONS §5.3): *upsert keyed on
  `(provider, providerUserId)`; apply only when `incoming.version > stored.version`; otherwise
  discard.* This sentence is the reason the whole versioning design exists. A customer who
  integrates the PUSH plane with a naive upsert records the wrong owner permanently and never finds
  out (DECISIONS §5). The doc must carry the sentence, not a paraphrase.
- **The three planes are documented explicitly so nobody guesses** (DECISIONS §3.2): PULL is
  authoritative, PUSH is at-least-once and reorderable, IN-PROCESS hooks are the only place a veto
  or an in-band write can live. Cut none of them.
- **Every outbound payload carries full current state, never a delta** (DECISIONS §5.2), including
  `{ state, version }`. Document that, because it is what makes the upsert rule sufficient.
- **`beforeLink` is fail-closed**; a throw, a timeout or `{ allow: false }` rejects the link
  (DECISIONS §6.7, §9). A veto hook that fails open is not a veto hook, and a customer reading the
  doc must know a slow hook means a rejected link.
- **The set stays open** (DECISIONS §3.1): a third party authors their own provider with
  `defineAccountLink` in their own repo and passes it via `accountLinks.providers`. The doc needs an
  "Adding another provider" section saying so, matching `docs/sms.md:230`.
- **Providers are NOT plugin packages** (DECISIONS §3.1), so the doc must NOT carry the
  install-a-direct-dependency warning that `docs/sms.md:16-28` carries. That warning is correct for
  `plugin-twilio` and wrong here, and copying it would teach the opposite of the locked decision.
- Out of scope for the doc: Epic / Xbox / PSN presets, the Framer script-tag drop-in, promoting a
  provider to a real `IdentityKind`, and `account.updated` (DECISIONS §12). These belong under
  `## Deferrals (v1)`.

## Acceptance criteria (EARS)

- WHEN a reader opens `docs/account-links.md` the system SHALL present the house shape: no front
  matter, an H1 noun phrase, one dense framing paragraph stating what a deploy with nothing
  configured does, sentence-case headings, and `## Deferrals (v1)` last.
- WHEN the doc describes the PUSH plane it SHALL state the upsert rule verbatim, in its own fenced
  or blockquoted block so it is quotable, and SHALL explain the failure it prevents (reorder,
  duplicate, late delivery).
- WHEN the doc describes env vars it SHALL use a ` ```bash ` block with commented-out optionals and
  aligned trailing `#` comments giving defaults, matching `docs/sms.md:33-40`, NOT a markdown table.
- WHEN the doc describes a provider's OAuth app setup it SHALL give the redirect URI as a bare
  fenced block containing the literal URL against a concrete hostname, matching
  `docs/connect-discord.md:128-132`.
- WHEN the doc describes redirect URIs it SHALL state the per-tenant property: instance-per-tenant
  means each customer registers their own OAuth app against their own `API_PUBLIC_URL`, so no
  Hogsend-operated app ever holds a customer's players' grants and a Hogsend compromise cannot
  surrender them.
- WHEN the doc lists prerequisites it SHALL state that `API_PUBLIC_URL` must not be loopback and
  SHALL carry a troubleshooting row for it, following `docs/connect-discord.md:430-441`.
- WHEN `apps/api` boots with no account-link credentials configured the system SHALL boot normally
  with the provider simply absent. An unconfigured deploy is inert, not broken.
- WHEN a provider is wired into `apps/api` it SHALL be registered in **both** `index.ts` and
  `worker.ts` with a mirroring comment in `worker.ts` explaining why the worker needs it, per the
  registry-mirror rule stated five times in `apps/api/src/worker.ts` (`:26`, `:31`, `:35`, `:39`,
  `:42`).
- WHEN the doc is added the system SHALL make it discoverable: a `CLAUDE.md` back-reference line in
  the form of `CLAUDE.md:161` / `:189` / `:193`, and a companion page on the docs site.

## Tasks

### T1 — `docs/account-links.md`
_Boundary:_ `docs`
_Depends:_ PRD 07, PRD 09, PRD 13

Model the shape on `docs/groups.md` and `docs/sms.md`, which are the current house shape.
`docs/tracking.md` is older (Title-Case headings, heavy tables) and should not be copied.

Heading outline, in order:

- `# Account links` as the H1, then one dense paragraph: what it is, the game-publisher framing, and the
  inert-when-unconfigured posture (no providers configured means no routes do anything and no
  behaviour changes).
- `## Setup`, a ` ```bash ` env block. Required vars uncommented, optional ones commented out with
  their defaults on an aligned trailing `#`:
  ```
  API_PUBLIC_URL=https://api.yourgame.com      # must NOT be loopback; redirect URIs derive from it
  # STEAM_WEB_API_KEY=xxxxxxxx                 # optional: adds persona, avatar, playtime. Steam
                                               #   login itself needs NO credential (OpenID 2.0)
  # ACCOUNT_LINK_TWITCH_CLIENT_ID=…           # only if you enable the Twitch provider
  # ACCOUNT_LINK_TWITCH_CLIENT_SECRET=…
  # ACCOUNT_LINK_ALLOWED_ORIGINS=https://play.yourgame.com   # required for the embed SDK
  ```
  Take the variable names from PRD 05's table verbatim rather than inventing them here.
- **State what a Steam login actually returns.** The docs MUST say plainly that it yields the
  17-digit steamid64 and NOTHING else — no display name, no avatar, and no email ever. Several
  widely-copied third-party tutorials claim the callback also carries name and avatar; it does not,
  those come from the keyed `GetPlayerSummaries` Web API. Say so explicitly so nobody later "fixes"
  the preset by expecting fields that never arrive. Valve's own page draws the same line: OpenID
  authenticates a SteamID, and separately "all use of the Steam Web API requires the use of an API
  Key" (`steamcommunity.com/dev`).

  **The doc must state that Discord is NOT an account-link provider** (DECISIONS §12). First-party
  providers are Steam and Twitch. Discord account linking already exists and works through
  `plugin-discord` (the `member_link` OAuth flow, `discordColdConnect`, and `contacts.discordId`),
  and that is the supported path; adding a second writer to `contacts.discordId` is exactly the
  drift risk this feature declined to take on. An operator reading the `ACCOUNT_LINK_` prefix will
  otherwise go looking for a Discord pair and find `DISCORD_CLIENT_SECRET`
  (`apps/api/src/env.ts:24`), which belongs to the separate Discord CONNECTOR. Say which is which,
  in one short paragraph, and link the Discord connector doc.
  Then the consumer wiring snippet (` ```ts `) showing `accountLinks: { providers, hooks }` in
  `createHogsendClient`, and the note that it goes in BOTH entry points.
- `## Linking from the browser`, the `<LinkAccountButton>` / `hogsend.linkAccount()` path from
  PRD 13, with the two facts a customer will otherwise get wrong: the call must originate from a
  click (a popup opened outside a user gesture is blocked), and there is deliberately no
  `accountLinkUrl()` because a browser cannot mint for an arbitrary contact (DECISIONS §6.5).
  Say plainly that this is NOT an iframe and why (DECISIONS §11).
- `## The three planes`, reproduce the DECISIONS §3.2 table (Plane / Surface / Job / Guarantee) and
  add one paragraph per plane saying which question it answers. State the choosing rule directly:
  reconcile from PULL, react from PUSH, veto from IN-PROCESS.
- `## The consistency contract`, the load-bearing section.
  - Explain the relink sequence: a relink moves an account from contact A to contact B and emits
    `account.unlinked` then `account.linked`, two independent deliveries with independent retries.
  - State that every payload carries FULL CURRENT STATE with `{ state, version }`, never a delta.
  - Then the rule, verbatim and set off on its own so it can be copied:
    > Upsert keyed on `(provider, providerUserId)`; apply only when
    > `incoming.version > stored.version`; otherwise discard.
  - One short paragraph on why one guard covers all three failure modes, and the explicit warning
    that **no timestamp is a valid tiebreaker** (DECISIONS §5.4).
  - A short paragraph, immediately under the rule, on the TYPE of `version`: it is a Postgres
    `bigint` and it crosses every boundary as a decimal STRING, so the comparison is
    `BigInt(incoming.version) > BigInt(stored.version)` or a numeric column in the consumer's own
    DB. `parseInt` rounds anything past `Number.MAX_SAFE_INTEGER` and breaks the guard silently, in
    exactly the case the guard exists for (DECISIONS §5.1). This belongs next to the rule, not in a
    types appendix, because a reader who copies the rule and drops it into `parseInt` has
    implemented the bug.
  - A worked example: v3 arriving before v4, then v4, then v3 again as a retry. Show the stored
    state after each.
- `## Events`, the three outbound events with their payloads (DECISIONS §8), and the two deliberate
  omissions with their reasons: no `account.link_started` (journeys mint URLs at volume and most are
  never clicked), no `account.updated` (read `tokensRevokedAt` from the pull plane instead).
- `## Hooks`, `beforeLink` / `afterLink` / `afterUnlink` with the postures from DECISIONS §9:
  `beforeLink` is blocking, 5s, FAIL-CLOSED; the other two are post-commit, at-least-once,
  FAIL-OPEN, bounded 5s, and `afterLink` runs before the success page renders so "you now have your
  reward" is true when the player reads it.
- `## Provider setup`, one H3 per provider, each in the `docs/connect-discord.md:120-143` form:
  where in the portal the credentials live, what env var each maps to, and a numbered step for the
  redirect URI ending in a bare fenced block with the literal URL against a concrete hostname:
  - `### Steam`, no OAuth app and no redirect registration at all (OpenID 2.0), just a Web API key
    from `https://steamcommunity.com/dev/apikey`. Note explicitly that Steam stores no tokens
    because none exist, so there is nothing to revoke and nothing to refresh.
  - `### Twitch`, the developer console, client id + secret, redirect:
    ```
    https://api.yourgame.com/v1/accounts/twitch/callback
    ```
  - There is deliberately no `### Discord` here; see the Setup section's note and
    `docs/connect-discord.md`.
  (The exact callback path is PRD 07's; whatever it ships, the doc quotes it literally.)
- `## Per-tenant redirect URIs`, short and load-bearing. Hogsend is deployed instance-per-tenant,
  so each customer registers their own OAuth app against their own `API_PUBLIC_URL`. Spell out the
  consequences: grants are issued to the customer's app, tokens are sealed in the customer's own
  database, and there is no shared Hogsend-operated OAuth app that could be compromised into
  surrendering another customer's players. Contrast it plainly with a multi-tenant SaaS that
  proxies every customer through one app. Then the operational cost, honestly: a customer must
  register their own app, and a redirect URI must be re-registered if `API_PUBLIC_URL` changes.
- `## Property sync`, the per-provider opt-in from PRD 14: `sync: { every: hours(24), read() }`, one
  cron, namespaced flat scalars on `contacts.properties`, a journey/bucket example reading
  `steam_playtime_2wk`, and the `invalid_grant` behaviour (the link survives, `tokensRevokedAt` is
  set, the sync stops, and nothing auto-unlinks). Carry PRD 01's one-line note that this is NOT the
  `EnrichmentProvider` / `refineContact()` subsystem, which is an unrelated thing with a similar
  name (DECISIONS §10), so a reader searching the codebase does not land in the wrong place. Say
  that `every` is a minimum AGE, not a schedule: the cron ticks on its own cadence and re-reads a
  row once it is older than `every`.
- `## Importing existing links`, `POST /v1/accounts/import`, INSERT-ONLY, returns
  `{ inserted, conflicts }`, stamps `method: "import"` (DECISIONS §6.2). Say why it cannot graft: an
  insert-only path structurally cannot move a link away from a live owner.
- `## Studio (observe views)`, mirroring `docs/groups.md:249`. Observe-only, no authoring. Note that
  Studio reads its own `/v1/admin/accounts` router (PRD 15), not the `hsk_`-scoped data plane,
  because the SPA is cookie-authed.
- `## Letting a player unlink`, presenting the TWO revoke surfaces in the order DECISIONS §14 locks
  them. The PRIMARY one is in-app: the publisher's server already mints a userToken for the rest of
  the SDK, so `GET /v1/accounts/me` plus the userToken-gated revoke (PRD 09) needs no email, no
  hosted page and no token in a URL. Show that integration first and in full. The hosted manage page
  (PRD 11) is the FALLBACK, for a player with no session who arrived from a link in an email or a
  DM; present it second and say plainly what it is for. State that both are ID-keyed, never
  email-keyed, and that the manage token is a dedicated `contactId`-keyed token: **Steam never
  yields an email**, so an email-keyed revoke surface would be unreachable for the normal case of
  this feature.
- `## Adding another provider`, the `docs/sms.md:230` analogue, adjusted: author it with
  `defineAccountLink()` in your own repo and pass it via `accountLinks.providers`. **Do not copy the
  install-a-direct-dependency warning from `docs/sms.md:16-28`**, account-link providers are not
  plugin packages (DECISIONS §3.1), and repeating that warning would teach the opposite.
- `## Security posture`, the `docs/groups.md:321` form, bolded claim plus prose per bullet, drawn
  from DECISIONS §6: only a completed hosted callback may MOVE a link; import is insert-only; the
  authoritative contact is the one sealed into the state token, never the provider-reported email;
  only a provider-verified email is folded in as an identity key; `pk_` cannot mint;
  `postMessage` targets an allowlist, never `*`; `beforeLink` is fail-closed;
  `GET /v1/accounts/me` never confirms existence. Plus the two the plan critique surfaced:
  **a COLD (anonymous, browser-keyed) link may attach only to an anonymous-only contact, and only a
  WARM userToken-sealed link may displace a live owner** (DECISIONS §6.10); and **the Steam
  `check_authentication` round trip is posted to Steam's hardcoded endpoint, never to the
  `openid.op_endpoint` the callback names** (PRD 01 T4), because an attacker who names the verifier
  answers their own verification.
- `## What a minted link URL looks like`, three sentences, because a customer will otherwise assume
  they get a platform URL. `mintAccountLinkUrl` / `POST /v1/accounts/link-url` /
  `POST /v1/accounts/mint-link` all return an ENGINE-origin
  `<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<token>` (DECISIONS §15.2). Send the player
  there; the engine 302s them to the platform's consent screen and handles the rest. The platform's
  own authorize URL is never handed to a caller.
- `## Troubleshooting`, a `| Symptom | Cause | Fix |` table, the `docs/connect-discord.md:430-441`
  form. At minimum: loopback `API_PUBLIC_URL`; a redirect URI mismatch; a popup that never returns
  (blocked, or not called from a click); a `postMessage` that is ignored (origin mismatch); a link
  that appears in Studio but not in the customer's DB (they are discarding by version, or their
  webhook endpoint is failing).
- `## Deferrals (v1)`, Epic / Xbox / PSN, the Framer drop-in, promoting a provider to a real
  `IdentityKind`, `account.updated`, and **Discord as a `defineAccountLink` provider** (DECISIONS
  §12). For the Discord row, link `docs/connect-discord.md` and say the existing connector is the
  supported path today, not a stopgap.

Also in this task, because a `/docs` file with no inbound link is invisible (there is no
`docs/README.md`, no `mkdocs.yml`, no index of any kind):
- Add the back-reference line to `CLAUDE.md`, in the exact form of `CLAUDE.md:161` ("Full docs:
  `docs/sms.md`."), appended to the account-links architecture section.
- Cite `docs/account-links.md` from the code it documents, matching how `docs/groups.md` is cited at
  `packages/engine/src/env.ts:156` and `packages/engine/src/container.ts:267`.

### T2 — Docs-site companion page
_Boundary:_ `apps/docs`
_Depends:_ T1

The site mirrors `/docs` by hand and by convention in the same commit: `docs/sms.md` and
`apps/docs/content/docs/guides/sms.mdx` were both created in `45e21887`, and later fixes touch both
together (`8e57f4dc`). There is no sync script, and the mdx is a friendlier rewrite, not a copy.

- New `apps/docs/content/docs/guides/account-links.mdx` with fumadocs front matter in the form of
  `apps/docs/content/docs/guides/sms.mdx:1-4`:
  ```
  ---
  title: Account links
  description: Link a player's Steam or Twitch account to a contact as an identity fact, a lifecycle event, and a row in your own database.
  ---
  ```
- Register it in the ordered `pages` array of `apps/docs/content/docs/guides/meta.json`. Ordered
  arrays, not filesystem order, so an unregistered page silently does not appear.
- The site page is shorter than the repo doc: lead with the browser button, the three planes, and
  the upsert rule. **The upsert rule must appear verbatim here too**, this is the page a customer's
  engineer actually reads, and it is the sentence that prevents the failure the whole versioning
  design exists for.
- Register the description text with the copy rules Doug applies to this repo: every line a fact
  that fails the deletion test, no marketing register.

### T3 — Dogfood: wire Steam into `apps/api`
_Boundary:_ `apps/api`
_Depends:_ PRD 05, PRD 06, T1

**Steam is the provider to wire, and the choice is deliberate.** It needs NO operator secret at all
to link: "Sign in through Steam" is OpenID 2.0, so there is no OAuth app, no client secret and no
redirect URI registration. `STEAM_WEB_API_KEY` is optional and only adds display properties plus the
PRD 14 sync. The dogfood proof is therefore reachable with a zero human ask. It also exercises the
hardest path: the bespoke OpenID 2.0 `check_authentication` round-trip and the token-free property
sync leg. Twitch is the only other v1 provider and needs an OAuth app, a client secret and a
registered redirect URI, so it is documented in T1 but not wired here. Discord is not an
account-link provider at all (DECISIONS §12): it links through `plugin-discord`, which
`apps/api/src/discord.ts` already wires and which this stack leaves untouched.

- New `apps/api/src/account-links/index.ts`, following the consumer-content-array convention exactly
  (`apps/api/src/webhook-sources/index.ts`, 11 lines, is the canonical form):
  ```ts
  import type { DefinedAccountLink } from "@hogsend/engine";
  import { steamAccountLink } from "@hogsend/engine";

  /**
   * The account-link providers this app offers. Passed to
   * `createHogsendClient({ accountLinks: { providers } })` in BOTH `index.ts`
   * and `worker.ts`. Edit freely — this is your content.
   */
  export const accountLinkProviders: DefinedAccountLink[] = [steamAccountLink];
  ```
  Keep the literal closing sentence "Edit freely, this is your content." It is the house marker for
  consumer-owned content.
- **No consumer env change.** `STEAM_WEB_API_KEY` is ENGINE-owned, because the concrete providers
  live in `@hogsend/engine` (DECISIONS §3.1) and PRD 06 reads it in
  `lib/account-links-from-env.ts` (PRD 06 T4). Do not mirror it into
  `apps/api/src/env.ts`; the `discordEnv` precedent exists because the Discord CONNECTOR vars are
  genuinely consumer-owned, and copying that pattern here would create a second source of truth for
  one key.
- `apps/api/src/index.ts`, import `./account-links/index.js` (biome sorts it to the top of the
  relative-import block, before `./buckets/index.js` at `:20`) and add the option to the
  `createHogsendClient({…})` literal, **after `sms: { templates: smsTemplates },` (`:54`) and before
  the connectors comment block (`:55`)**. Every option there carries a preceding `//` comment stating
  the inert-when-unconfigured posture; match it:
  ```ts
  // Account links — a player proves control of a platform account and it
  // becomes an identity fact + a lifecycle event. Steam needs no credential
  // at all; STEAM_WEB_API_KEY only adds persona name, avatar and playtime.
  accountLinks: { providers: accountLinkProviders },
  ```
- `apps/api/src/worker.ts`, the same import and the same option after
  `sms: { templates: smsTemplates },` (`:41`), with a **mirroring comment** in the form of the five
  already there, naming what the worker path needs it for: the hooks and the property-sync cron run in
  the worker process, so the worker's provider registry must match the API's.
- `apps/api/vitest.config.ts`, add `STEAM_WEB_API_KEY` to the injected `test.env` block, following
  the `STRIPE_WEBHOOK_SECRET` precedent (added there specifically so an env preset auto-mounts and a
  test can assert it). Note the measured behaviour recorded in that file: vitest's `test.env`
  OVERRIDES the ambient `process.env`, so this is the only place that matters for tests.

Tests — `apps/api/src/__tests__/account-links-wiring.test.ts`, using the content-registration idiom
from `apps/api/src/__tests__/webhook-sources.test.ts:10-11` (`createHogsendClient({ accountLinks: { providers } })`
then `createApp(container)`, then `app.request()`; `it`, never `test`):
- `"registers the Steam provider in the container registry"`
- `"the hosted start route is mounted for a registered provider"`
- `"boots with no STEAM_WEB_API_KEY and the Steam provider still links"` (the zero-config proof —
  assert the provider is PRESENT and its start route mounts; the key is a widener, not a switch)
- `"index.ts and worker.ts register the same provider ids"`. Assert the registry-mirror rule
  directly rather than trusting a comment. Import both content arrays and compare.

## Seams

**Real provider credentials.** This is the known seam named in `BACKLOG.md:39-42`. Build to the
deterministic Fakes, keep every gate green without a single secret, mark the PRD `[~]`, and keep
going.

The exact human ask, enumerated so it can be handed over as one message:

1. **Steam Web API key — OPTIONAL, not a blocker.** From `https://steamcommunity.com/dev/apikey`,
   signed in with a Steam account that owns at least one game. Requires a domain name at
   registration; use the production API host. Set as `STEAM_WEB_API_KEY`. **T3 needs no credential
   at all** — Steam linking works on a bare deploy; this key only adds persona name, avatar and the
   PRD 14 playtime sync.
2. **Twitch application**, at `https://dev.twitch.tv/console/apps`: create an app, copy **Client
   ID** and **Client Secret**. Register the OAuth Redirect URL exactly:
   `<API_PUBLIC_URL>/v1/accounts/twitch/callback`
   Set as `ACCOUNT_LINK_TWITCH_CLIENT_ID` / `ACCOUNT_LINK_TWITCH_CLIENT_SECRET`. Not needed for T3.
3. **A non-loopback `API_PUBLIC_URL`** for any live OAuth test. Twitch rejects loopback redirect
   URIs on a public app, and this repo already treats loopback as a first-class
   failure with its own error code (`api_public_url_unreachable`,
   `packages/cli/src/lib/connect-flow.ts:72`). For a local run, a tunnel URL set as
   `API_PUBLIC_URL` and the API restarted.

Also owed outside this stack, per `BACKLOG.md:44-45`: **file the Epic Games organization application
now.** Approval takes weeks and v2 is otherwise gated on it. Not a blocker for this PRD; a calendar
item.

## Done when

- [ ] `docs/account-links.md` exists in the house shape: no front matter, sentence-case headings,
      `## Deferrals (v1)` last.
- [ ] The upsert rule appears **verbatim** in `docs/account-links.md` AND in
      `apps/docs/content/docs/guides/account-links.mdx`. Grep both for
      `incoming.version > stored.version`.
- [ ] The three planes each have a section saying which question they answer.
- [ ] The doc states that `version` is a decimal string for a `bigint` column, next to the upsert
      rule, and shows `BigInt()` in the comparison rather than `parseInt`.
- [ ] The unlink section presents the userToken in-app revoke FIRST as the primary surface and the
      hosted manage page second as the no-session fallback (DECISIONS §14).
- [ ] Every provider's redirect URI appears as a literal URL in a bare fence, not a placeholder-only
      form.
- [ ] The per-tenant redirect section states both the security property and its operational cost.
- [ ] The doc carries a troubleshooting table including the loopback `API_PUBLIC_URL` row.
- [ ] The doc does NOT carry the plugin install-a-direct-dependency warning.
- [ ] `apps/docs/content/docs/guides/account-links.mdx` is registered in that directory's
      `meta.json` `pages` array, and the docs site builds.
- [ ] `CLAUDE.md` carries the "Full docs: `docs/account-links.md`." back-reference.
- [ ] `apps/api/src/index.ts` and `apps/api/src/worker.ts` both register `accountLinkProviders`, and
      a test asserts the two registrations match rather than relying on the comment.
- [ ] `apps/api` boots with no `STEAM_WEB_API_KEY`, the Steam provider is still registered, and a
      test proves both.
- [ ] The PRD is marked `[~]` in `BACKLOG.md` with the four-item human ask above copied into the
      handover, unless the credentials arrive first.
- [ ] Gates green from the worktree root:
      ```
      pnpm lint
      pnpm check-types
      cd apps/api && pnpm test
      ```
- [ ] No changeset needed for `docs/` alone; one IS needed if T3's wiring touches any published
      package surface.
- [ ] One conventional commit per task (`docs:` for T1/T2, `feat:` for T3), local only. No push, no
      PR (DECISIONS §13).

## Implementation Notes
