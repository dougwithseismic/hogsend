# PRD 10 — Hosted pages + shared branding

## Goal

Give the account-link flow its two hosted pages (success, error) and, in the same stroke, extract
cold-connect's branding + XSS discipline into ONE shared module both flows use. Two copies of an XSS
posture is two postures that drift, and the one that drifts is the one nobody is looking at. Also
ship the headless escape hatch so a customer can render the result on their own domain.

**The landing / confirm page is CUT.** An earlier draft added a third page at
`GET /v1/accounts/link/:provider?state=`. DECISIONS §15.2 settles the flow shape without it:
`mintAccountLinkUrl` returns `<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<state>`, and `/start`
302s straight to the provider's authorize URL. Nothing in the stack ever navigated to the landing
page, PRD 07 mounted no route for it, and keeping it would have meant a third reserved provider id
(`"link"`), a third exclusion in PRD 09's route guard, and a second page that can render a state.
The player's consent step is the PROVIDER's consent screen, which is the only one that proves
anything. If a pre-consent interstitial is wanted later it is a customer-side page that links to the
minted `/start` URL, and it needs nothing from the engine.

## Locked decisions specific to this PRD

- Generalize `ColdConnectBranding` into a shared branding module rather than forking it
  (DECISIONS §3.3, "Hosted-page branding + XSS discipline" row).
- `postMessage` targets a **configured origin allowlist, never `*`** (DECISIONS §6.6, §11).
- The embed model is button + popup + `postMessage`, explicitly NOT an iframe (DECISIONS §11): Steam,
  Discord and Twitch all send `X-Frame-Options: DENY` / restrictive `frame-ancestors` on their
  consent screens.
- `afterLink` runs BEFORE the success page renders, bounded at 5s, fail-open (DECISIONS §9), so "you
  now have your reward" is true when the player reads it. The page renders anyway on timeout.
- The authoritative contact is the one sealed into the state token, never a provider-reported email
  (DECISIONS §6.3). Nothing on these pages may resolve a contact from anything the page carries.

## Grounding in the real tree (read all of it before writing code)

`packages/engine/src/cold-connect/page.ts` is the whole security posture. The controls, by line:

- `:7-37` — `ColdConnectBranding`, every field documented as PLAIN TEXT, not HTML.
- `:39` — `ACCENT_RE = /^#[0-9a-fA-F]{6}$/`; `:41` `DEFAULT_ACCENT = "#1f6feb"` (AA-safe white-on-accent).
- `:53-58` — `jsonForScript()`: `JSON.stringify` then escape `<`, `>`, `&` to `<`, `>`,
  `&`. `JSON.stringify` does NOT escape `<`, so an embedded `</script>` closes the tag early.
  This page has no CSP; that escape IS the control.
- `:63-67` — `isSafeIconSvg()`: fail-closed shape check for the ONE raw-inlined field. Must start with
  `<svg` and must not match `/<script|\son\w+\s*=|javascript:/i`.
- `:97-112` — accent validated before it reaches the stylesheet; a malformed `iconSvg` falls back to
  the emoji badge and logs a warning rather than inlining anything.
- `:114-129` — every text field goes into the JSON config, never into the markup.
- `:216-222` — the markup has EMPTY text nodes; `:233-238` fills them with `textContent`. That is why
  no branding field can inject markup.
- `:224-225` — `?tok=` is read CLIENT-side from `location.search` and never reflected into the HTML.
- `:265-277` — the bind happens on a human button CLICK (POST). A GET never binds, so an email
  link-preview prefetch cannot complete it. `cold-connect/index.ts:146-158` is the matching comment
  on the GET route ("pure page render, no writes").
- `:136` — `<meta name="robots" content="noindex">`.

Also read `packages/engine/src/cold-connect/index.ts:145-241` (route mounting, `afterBind` posture at
`:222-234`) and `packages/engine/src/index.ts:127` (where `ColdConnectBranding` is re-exported from
the engine's public surface, so any rename is a semver event).

Counter-example to NOT follow: `packages/engine/src/lib/html.ts:1-26` interpolates `body` raw, and
`routes/email/preferences.ts:207` interpolates `${email}` into it unescaped. That is the older,
weaker page path. The account-link pages use the cold-connect posture, not `htmlPage`.

## Acceptance criteria (EARS)

### The shared branding module (no weakening)

- WHEN branding is rendered by EITHER flow, the system SHALL write every plain-text field
  (`title`, `blurb`, `successCopy.*`, `errorCopy.*`, `badge`, `eyebrow`, `reassurance`) via
  `textContent` from a JSON config, and SHALL NOT interpolate any of them into the markup string.
- WHEN a branding field contains `</script><script>alert(1)</script>`, the system SHALL render it as
  visible literal text and SHALL NOT execute it.
- WHEN a branding field contains `<img src=x onerror=alert(1)>`, the system SHALL render it as
  visible literal text.
- WHEN `accentColor` does not match `/^#[0-9a-fA-F]{6}$/`, the system SHALL substitute `#1f6feb` and
  SHALL NOT emit the supplied value into the stylesheet.
- WHEN `iconSvg` fails `isSafeIconSvg`, the system SHALL fall back to the emoji badge and SHALL log a
  warning naming the flow.
- WHEN `iconSvg` passes, the system SHALL inline it verbatim — the ONE developer-authored exception,
  and it SHALL remain documented as such in the type's doc comment.
- WHEN the shared module is extracted, the system SHALL keep `ColdConnectBranding` exported from
  `@hogsend/engine` as a type alias of the shared interface, so `packages/engine/src/index.ts:127`
  and every consumer import keeps compiling.

### No landing page

- WHEN this PRD ships, the system SHALL expose NO `GET /v1/accounts/link/:provider` route, and
  `"link"` SHALL NOT be added to `RESERVED_ACCOUNT_LINK_IDS`. The entry point is PRD 07's `/start`
  (DECISIONS §15.2).

### The success page and `postMessage`

- WHEN a callback completes successfully, `afterLink` SHALL already have run (inside PRD 03's
  awaited `linkAccount`, bounded at 5s, fail-open) BEFORE the success page is rendered, and the page
  SHALL render even when `afterLink` throws or times out. This PRD does NOT invoke the hook: the
  store is its sole invoker (DECISIONS §15.4). This is an ordering criterion, not an invocation one.
- WHEN the success page loads and `window.opener` is present, the system SHALL `postMessage` a
  payload of the shape `{ source: "hogsend", type: "account.linked", provider, username, avatarUrl }`
  to EACH configured allowlisted origin in turn, and SHALL then `window.close()`.
- WHEN the origin allowlist is empty or unconfigured, the system SHALL NOT call `postMessage` at all
  and SHALL still render and close. Silence is the fail-closed default.
- WHEN `postMessage` is called, the `targetOrigin` argument SHALL be a concrete origin string. It
  SHALL NEVER be `"*"`, and a lint-visible test SHALL assert the emitted page source contains no
  `postMessage(` call whose second argument is `"*"`.
- WHEN the posted payload is built, it SHALL carry display fields only — the same four-field shape
  `GET /v1/accounts/me` returns (PRD 09 T2). It SHALL NOT carry `providerUserId`, `contactId`,
  `version` or any token.
- WHEN `window.opener` is absent (the flow was opened as a top-level navigation, not a popup), the
  system SHALL render the success copy and SHALL NOT attempt to close the tab.

### The error page

- WHEN a callback fails for any reason (`denied`, `vetoed`, `exchange_failed`, `state_invalid`), the
  system SHALL render the error page with `errorCopy` and SHALL NOT disclose which of those four
  reasons occurred in the visible copy.
- WHEN the error page renders, the system SHALL `postMessage` `{ source: "hogsend", type: "account.link_failed", provider }`
  to the allowlist under the same rules, so the embedding button can stop spinning.
- WHEN a callback fails, the system SHALL NOT mint a contact (DECISIONS §8, `account.link_failed`
  row).

### The headless escape hatch

- WHEN a provider definition or the container config supplies a `resultRedirect` for the flow, the
  system SHALL respond `302` to that URL instead of rendering a page, appending a SHORT-LIVED SIGNED
  result token as a query parameter.
- WHEN the result token is minted, it SHALL be an HMAC over `BETTER_AUTH_SECRET` in the existing
  `connector-state.ts` idiom (`base64url(JSON(payload)).base64url(HMAC)`), SHALL carry only
  `{ status, provider, username, avatarUrl, exp }`, and SHALL expire within 120 seconds.
- WHEN the result token payload is built, it SHALL NOT carry `providerUserId`, `contactId` or
  `version`. The customer already has the pull plane for those, authenticated.
- WHEN `resultRedirect`'s origin is not on the configured allowlist, the system SHALL refuse at BOOT
  (throw during container construction), not at request time. A misconfigured redirect target is an
  open-redirect primitive and must never reach production quietly.
- WHEN no `resultRedirect` is configured, the system SHALL render the hosted page (the default).

### Cold-connect regression

- WHEN cold-connect is refactored onto the shared module, `coldConnectPageHtml` SHALL produce output
  that still satisfies every existing cold-connect assertion: `textContent` writes, accent
  validation, `jsonForScript` breakout escaping, `isSafeIconSvg` fallback, the client-side `?tok=`
  read, and the click-only POST bind.
- WHEN cold-connect renders, the visible behavior SHALL be unchanged for a consumer (Discord and
  Telegram cold-connect flows keep working with no config edit).

## Tasks

### T1 — Extract the shared branding module
_Boundary:_ `packages/engine`
_Depends:_ —

New `packages/engine/src/hosted-pages/branding.ts`, lifted verbatim from
`cold-connect/page.ts:7-67` with the flow-agnostic name:

```ts
export interface HostedPageBranding {
  title: string;
  blurb: string;
  successCopy: { heading: string; body: string };
  errorCopy: { heading: string; body: string };
  badge: string;
  /** The ONE verbatim-inlined field. Static, developer-authored `<svg>…</svg>` ONLY. */
  iconSvg?: string;
  accentColor?: string;
  eyebrow?: string;
  reassurance?: string;
}

export const ACCENT_RE: RegExp;
export const DEFAULT_ACCENT: string;
export function jsonForScript(value: unknown): string;
export function isSafeIconSvg(svg: string | undefined): svg is string;
export function resolveAccent(accentColor: string | undefined): string;
export function resolveIconSvg(iconSvg: string | undefined, flow: string): string | undefined;
export function hostedPageShell(opts: {
  branding: HostedPageBranding;
  config: Record<string, unknown>;   // JSON-embedded, jsonForScript-escaped
  bodyScript: string;                // flow-specific client JS
}): string;
```

`hostedPageShell` owns the `<style>` block, the empty-text-node markup
(`cold-connect/page.ts:216-222`), the `textContent` fill (`:233-238`), the grain, the
`meta robots noindex`, and the reduced-motion block. The flow supplies only `config` and
`bodyScript`.

Zero behavior change is the whole point of this task: the CSS, the defaults and the escape functions
are copied, not rewritten.

Tests (`apps/api/src/__tests__/hosted-page-branding.test.ts`):
- `jsonForScript escapes < > and &`
- `a </script> payload in a branding field cannot break out of the inline script`
- `isSafeIconSvg rejects a script tag, an on* handler and a javascript: URL`
- `isSafeIconSvg accepts a plain <svg>`
- `resolveAccent substitutes the default for a malformed accent`
- `resolveAccent accepts a 6-digit hex`
- `hostedPageShell emits empty text nodes and fills them via textContent`
- Mutation check: dropping the `<` replacement from `jsonForScript` must fail the breakout test.

### T2 — Refactor cold-connect onto the shared module
_Boundary:_ `packages/engine`
_Depends:_ T1

`packages/engine/src/cold-connect/page.ts` keeps `coldConnectPageHtml` and its signature, but its
body becomes a call to `hostedPageShell` with the cold-connect `config` (`posthogKey`, `posthogHost`,
`exchangeUrl`, `identifyPropKey`) and the cold-connect `bodyScript` (the posthog loader + the
click-to-POST bind). `ColdConnectBranding` becomes:

```ts
export type ColdConnectBranding = HostedPageBranding;
```

so `packages/engine/src/index.ts:127` and `cold-connect/index.ts:18` keep exporting the same name and
no consumer breaks.

This task has its OWN regression tests, run against the refactored output — a shared-module extraction
that silently loosens one escape is the exact failure this PRD exists to prevent.

Tests (`apps/api/src/__tests__/cold-connect-page-regression.test.ts`):
- `renders the badge emoji via textContent, not markup`
- `a branding title containing markup renders as literal text`
- `a malformed accentColor falls back to #1f6feb and never reaches the stylesheet`
- `a malformed iconSvg falls back to the emoji badge and warns`
- `a valid iconSvg is inlined verbatim`
- `the page never contains the tok query value` (the client-side-read invariant)
- `the GET route performs no write` — hit `GET /connect/<id>?tok=…` and assert no `user_events` row
  and no state consumed, pinning `cold-connect/index.ts:146-158`.
- Snapshot the pre-refactor `coldConnectPageHtml` output for a fixed branding fixture and assert the
  post-refactor output is semantically equivalent (same config keys, same escaped forms).

### T3 — CONSUME the origin allowlist
_Boundary:_ `packages/engine`
_Depends:_ PRD 05

**PRD 05 owns the allowlist end to end** and this task only reads it. PRD 05 T2 declares
`ACCOUNT_LINK_ALLOWED_ORIGINS`, PRD 05 T3's `parseAllowedOrigins` (`lib/account-link-origins.ts`)
validates it and THROWS at boot on a path, a bare `*`, a wildcard host or an unparseable value, PRD
05 T4 puts `allowedOrigins?: string[]` on the `accountLinks` option group and merges it env-first /
consumer-last, and the result is `client.accountLinkAllowedOrigins`. Do not redeclare the env var, do
not re-add the option, and do not write a second parser.

Two earlier drafts disagreed here and the conflict was behavioural, not cosmetic: PRD 05 said a
malformed entry is DROPPED with a warning, this PRD said it THROWS, and each had tests pinning its
own answer. Throw won (DECISIONS-level reasoning is in PRD 05's acceptance criteria). It also
matters for the criterion below: the boot-time `resultRedirect` check reads this same list, so under
drop-and-warn a typo'd origin silently shrinks the list and a legitimate `resultRedirect` throws at
boot for entirely the wrong reason.

This task's only job is to read `client.accountLinkAllowedOrigins` in the page builder and in the
`resultRedirect` boot check.

Tests (`apps/api/src/__tests__/account-link-pages.test.ts`):
- `the success page targets exactly the configured origins`
- `a resultRedirect whose origin is absent from the list throws at boot`
- `a resultRedirect on a listed origin boots`

### T4 — The account-link hosted pages
_Boundary:_ `packages/engine`
_Depends:_ T1, T3

`packages/engine/src/routes/accounts/pages.ts` exporting `accountLinkSuccessHtml(...)` and
`accountLinkErrorHtml(...)`, each a `hostedPageShell` call. There is no third page and no third
route: PRD 07's callback renders success or error inline, because it already holds the verdict.

The success `bodyScript`:

```js
var CFG = <jsonForScript config>;
if (window.opener && CFG.allowedOrigins.length) {
  for (var i = 0; i < CFG.allowedOrigins.length; i++) {
    try { window.opener.postMessage(CFG.message, CFG.allowedOrigins[i]); } catch (e) {}
  }
  setTimeout(function () { window.close(); }, 250);
}
```

`CFG.message` is built server-side from the four display fields only.

Tests (`apps/api/src/__tests__/account-link-pages.test.ts`):
- `no GET /v1/accounts/link/:provider route exists` (assert 404, so the cut page cannot creep back in
  without a deliberate decision)
- `the success and error pages send Cache-Control: no-store and robots noindex`
- `the success page posts to every allowlisted origin and to none other`
- `the success page source contains no postMessage with a "*" target` — assert against
  `/postMessage\([^)]*,\s*["']\*["']\s*\)/` over the rendered HTML.
- `an empty allowlist suppresses postMessage entirely and still renders`
- `the posted payload carries only provider, username, avatarUrl` (assert the key set)
- `the error page posts account.link_failed and does not name the failure reason in the copy`
- `the error page mints no contact`
- Mutation check: replacing an allowlist entry with `"*"` in the page builder must fail the
  wildcard test.

### T5 — Assert `afterLink` has already run when the success page renders
_Boundary:_ `packages/engine`
_Depends:_ T4

**No production change.** PRD 07's callback already `await`s `linkAccount`, and PRD 03's store
invokes `afterLink` post-commit inside that await with the fail-open posture of
`cold-connect/index.ts:222-234`. So the DECISIONS §9 ordering is satisfied by construction and this
task only pins it. Do NOT add an `afterLink` call here: the store is the sole invoker (DECISIONS
§15.4), and a second call fires every customer hook twice with nothing failing loudly, because the
hook is documented at-least-once.

Tests (`apps/api/src/__tests__/account-link-hooks.test.ts` — shared with PRD 07):
- `afterLink resolves before the success page body is produced` (assert ordering via a recording hook)
- `a successful callback invokes afterLink exactly once` (count, do not merely observe)
- `a throwing afterLink still renders the success page`
- `a hanging afterLink is abandoned at 5s and the success page still renders`

### T6 — Headless escape hatch
_Boundary:_ `packages/engine`
_Depends:_ T3, T4

`resultRedirect?: string` on the provider definition and/or `accountLinks` config. When set, the
callback responds `302` to `resultRedirect + (separator) + "hs_result=" + token`, minted with a
`signAccountLinkResult` helper in `packages/engine/src/lib/account-link-result.ts` reusing the
`connector-state.ts:44-52` sign/verify shape with a 120s TTL. Export a
`verifyAccountLinkResult({ token, secret })` from `@hogsend/engine` so a customer's server can
verify it, and mirror the verifier into `@hogsend/client` in PRD 12 if it fits there without dragging
the engine into the client's type graph (it should: it is `node:crypto` only).

Tests (`apps/api/src/__tests__/account-link-headless.test.ts`):
- `302s to the configured redirect with a signed hs_result token`
- `the result token verifies and carries only status, provider, username, avatarUrl, exp`
- `the result token expires at 120s`
- `a tampered result token fails verification`
- `an off-allowlist resultRedirect throws at container construction, not at request time`
- `with no resultRedirect the hosted page renders as before`

### T7 — Changeset
_Boundary:_ `packages/engine`
_Depends:_ T6

Minor changeset for `@hogsend/engine`: shared hosted-page branding module, account-link hosted pages,
origin allowlist, headless result redirect. Note in the changeset that `ColdConnectBranding` is now a
type alias of `HostedPageBranding` and is source-compatible.

## Seams

None for the pages themselves — PRD 06's deterministic Fake provider drives the whole
start → callback → success/error path in tests. Real Steam/Twitch credentials are the PRD 07/16 seam
and are not needed here.

## Done when

- [ ] `hosted-page-branding.test.ts` covers every escape and every fallback, and each one fails when
      its guard is removed.
- [ ] `cold-connect-page-regression.test.ts` passes against the refactored `coldConnectPageHtml`, and
      cold-connect's own existing suite is untouched and green.
- [ ] No `postMessage` in the engine targets `"*"`, proven by a source-level assertion, not by review.
- [ ] The empty-allowlist case is silent and fail-closed.
- [ ] `ColdConnectBranding` is still exported from `@hogsend/engine` and still type-checks for
      existing consumers (`pnpm build` at the root proves it).
- [ ] An off-allowlist `resultRedirect` throws at boot, reading PRD 05's validated
      `client.accountLinkAllowedOrigins`. This PRD declares no env var and writes no origin parser.
- [ ] No landing-page route exists, asserted by a test.
- [ ] `grep -n "afterLink" packages/engine/src/routes/accounts/pages.ts` returns nothing.
- [ ] Changeset added for `@hogsend/engine`.
- [ ] From the worktree root (DECISIONS §4):
      ```
      pnpm -C $WT lint
      pnpm -C $WT/packages/<pkg> exec tsc --noEmit   # NOT root check-types: vacuous
      pnpm -C $WT/apps/api test
      pnpm -C $WT exec turbo run test --filter='!@hogsend/api'   # `exec` is load-bearing
      ```
- [ ] Public-surface change, so also: `pnpm build`.

## Implementation Notes
