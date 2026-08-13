# PRD 13 — Embed SDK: popup + postMessage

## Goal

Give a customer a drop-in browser link flow with no backend of their own: one call
`hogsend.linkAccount("steam")` opens a popup at a freshly minted hosted link URL and resolves when
the hosted success page posts back. Ship an unstyled `<LinkAccountButton>` in `@hogsend/react` over
it, plus a userToken-reactive `hogsend.linkedAccounts()` read of `GET /v1/accounts/me`.

## Locked decisions specific to this PRD

- **Popup, never an iframe** (DECISIONS §11). Steam and Twitch both send
  `X-Frame-Options: DENY` / restrictive `frame-ancestors` on their consent screens, so a framed flow
  is structurally impossible. The transport is `window.open` + `postMessage`.
- **`POST /v1/accounts/link-url` returns an ENGINE-origin URL** (DECISIONS §15.2). The whole origin
  guard below depends on it; see T2 step 3.
- **`postMessage` targets a configured origin allowlist, never `*`** (DECISIONS §6.6). This PRD owns
  the RECEIVING half: the listener verifies `event.origin` and `event.source` before trusting a
  message. The sending half (the hosted success page) is PRD 10.
- **Browsers can never mint for an arbitrary contact** (DECISIONS §6.5). `pk_` is anon-only, so
  `POST /v1/accounts/link-url` is gated on the server-minted **userToken** and mints for that user
  only. Consequently there is **no `hogsend.accountLinkUrl()`** on the public surface: exposing a
  URL minter would imply a caller could choose the subject, which is exactly the thing that cannot
  be true.
- **`GET /v1/accounts/me` returns display fields only and never confirms existence** (DECISIONS
  §6.9). No token yields `[]`, not an error, so `linkedAccounts()` never throws on an anon visitor.
  PRD 09 T2 locks that shape to **exactly four keys** (`provider`, `username`, `avatarUrl`,
  `linkedAt`) via `serializePublicLinkedAccount`, which "structurally cannot carry an id". This PRD
  mirrors those four keys and adds none.
- **The `postMessage` payloads are PRD 10's**, not this PRD's:
  `{ source: "hogsend", type: "account.linked", provider, username, avatarUrl }` on success and
  `{ source: "hogsend", type: "account.link_failed", provider }` on failure. The error payload
  deliberately carries **no reason**, because PRD 10 does not disclose which of the four failure
  reasons occurred. This PRD consumes those shapes verbatim.
- **The DX unlock is that the customer needs no backend endpoint** (DECISIONS §11). Everything here
  is browser-direct against the configured `apiUrl`.
- Out of scope: a Framer / script-tag third-party drop-in (DECISIONS §12). `pk_` is anon-only and
  the userToken story there is unsolved.

## Acceptance criteria (EARS)

- WHEN `hogsend.linkAccount(provider)` is called the system SHALL open the popup window
  **synchronously, before any `await`**, so the call still sits inside the user-gesture window that
  browser popup blockers require.
- WHEN `window.open` returns `null` (popup blocked, or the call did not originate from a click) the
  system SHALL reject with `PopupBlockedError` and SHALL NOT issue the mint request.
- WHEN the popup is open the system SHALL `POST /v1/accounts/link-url`, then navigate the
  already-open popup to the returned URL by assigning `popup.location.href`.
- WHEN `POST /v1/accounts/link-url` fails the system SHALL close the popup and reject with the
  transport's `HogsendAPIError`.
- WHEN a `message` event arrives the system SHALL trust it only if ALL of: `event.origin` strictly
  equals the origin of the minted link URL, `event.source` is the popup window handle this call
  opened, `data.source === "hogsend"`, and `data.provider` equals the requested provider. Otherwise
  the system SHALL ignore the message and keep waiting.
- WHEN a trusted `account.linked` message arrives the system SHALL resolve with the four display
  fields, refresh the `accountLinks` slice, close the popup, and remove every listener and timer it
  installed.
- WHEN a trusted `account.link_failed` message arrives the system SHALL reject with
  `AccountLinkFailedError`. That error carries no `reason`, because PRD 10's error payload does not
  disclose one.
- WHEN the popup is closed by the player before any trusted message arrives the system SHALL wait a
  short grace period before rejecting with `AccountLinkCancelledError`. PRD 10's success page calls
  `window.close()` immediately after posting, so an observed close is the NORMAL success path and a
  cancel verdict raced against the in-flight message would fail a successful link.
- WHEN the configured origin allowlist on the engine side is empty the hosted page posts nothing at
  all (PRD 10's fail-closed silence), so the flow SHALL end in `AccountLinkTimeoutError` rather than
  hanging forever. This is the single most likely first-run misconfiguration, so the error message
  SHALL name it.
- WHEN `timeoutMs` elapses with no trusted message the system SHALL close the popup and reject with
  `AccountLinkTimeoutError`.
- WHEN the promise settles for ANY reason the system SHALL have removed its `message` listener and
  cleared its `popup.closed` poll interval and its timeout timer.
- WHEN `hogsend.linkedAccounts()` is called without a userToken the system SHALL resolve to `[]` and
  SHALL NOT throw.
- WHEN `hogsend.setUserToken()` is called the system SHALL re-fetch the `accountLinks` slice, and
  WHEN `hogsend.reset()` is called the system SHALL clear the slice synchronously before re-fetching.
- WHEN `<LinkAccountButton>` renders with no `className` the system SHALL emit a bare
  `<button type="button">` carrying only `hsr-link-account` class hooks and `data-*` state
  attributes, with **no rule for those classes in `styles.css`**, so the host page's own cascade
  is the only thing that styles it.
- WHEN `<LinkAccountButton>` is clicked the system SHALL call `linkAccount` directly in the click
  handler (no intervening `await`), set `data-hs-state="pending"` while in flight, and call
  `onLinked` or `onError` exactly once.

## Tasks

### T1 — `accountLinks` slice + `hogsend.linkedAccounts()`
_Boundary:_ `packages/js`
_Depends:_ — (consumes PRD 09's `GET /v1/accounts/me`)

Add the read half first so T2 has somewhere to write its result.

- `packages/js/src/types.ts`, add to `HogsendState` (currently `packages/js/src/types.ts:274-297`)
  an optional slice, following the feed slice's stable-reference discipline documented at
  `packages/js/src/types.ts:299-304`:
  ```ts
  /**
   * EXACTLY the four keys `serializePublicLinkedAccount` emits (PRD 09 T2).
   * No id, no method, no version, no token. Adding a field here without
   * adding it there is a bug in this file, not a gap in the API.
   */
  export interface LinkedAccountDisplay {
    provider: string;
    username: string | null;
    avatarUrl: string | null;
    linkedAt: string;
  }

  export interface AccountLinksSliceState {
    /**
     * A stable array reference, replaced wholesale on each fetch. Unlike the
     * feed there is no byId/order split: the feed needs one because realtime
     * upserts individual items, and this slice only ever whole-list replaces.
     */
    items: LinkedAccountDisplay[];
    status: "idle" | "loading" | "ready" | "error";
  }
  ```
  and `accountLinks?: AccountLinksSliceState;` on `HogsendState`. Add
  `linkedAccounts(): Promise<LinkedAccountDisplay[]>` and `linkAccount(...)` to the public `Hogsend`
  interface next to the groups block at `packages/js/src/types.ts:347-359`.
- New `packages/js/src/account-links/index.ts`, mirroring `packages/js/src/feed/index.ts:241-415`
  (`createFeedStore`) and `:433-465` (`createFeedClient`):
  ```ts
  export function createAccountLinksStore(store: Store<HogsendState>): AccountLinksStore;
  export function createAccountLinksClient(opts: {
    transport: Transport;
    identity: IdentityStore;
    store: AccountLinksStore;
  }): AccountLinksClient;
  ```
  `AccountLinksClient.list()` calls `transport.get<{ accounts: LinkedAccountDisplay[] }>("/v1/accounts/me", identityParams(identity))`,
  reusing `identityParams` verbatim from `packages/js/src/feed/index.ts:154-161`. `refetch()` and
  `clear()` mirror the feed's.
- `packages/js/src/client.ts`, construct one store + client alongside the flags client
  (`packages/js/src/client.ts:66-70` seeds the root state; the flags client is built near
  `:233-246`). Expose `linkedAccounts()` on the returned object near the groups block at
  `packages/js/src/client.ts:478-480`.
- **userToken reactivity**, the userToken is a closure variable, NOT store state
  (`packages/js/src/identity/identity-store.ts:82`, and the comment at
  `packages/js/src/client.ts:315-317` says a token write fires no subscription). So follow the
  feed's imperative fan-out, not a `store.subscribe`: add `void accountLinksClient.refetch()` to
  `setUserToken` (`packages/js/src/client.ts:453-457`) and, in `reset()`
  (`packages/js/src/client.ts:465-476`), `accountLinksStore.clear()` synchronously **before** the
  refetch, exactly as the feed stores are cleared at `:473`.
- `packages/js/src/index.ts`, export `createAccountLinksClient`, `createAccountLinksStore` and the
  new types. Exports in this file are alphabetically sorted; they slot before `createBannerClient`
  at `packages/js/src/index.ts:25`.

Tests — new `packages/js/src/__tests__/account-links.test.ts`, using the `newClient(fetchImpl)` +
recording-fake-`fetch` harness copied from `packages/js/src/__tests__/groups.test.ts:15-49`:
- `"linkedAccounts sends the userToken once identified"`
- `"linkedAccounts resolves to an empty list for an anon visitor"` (asserts no throw)
- `"setUserToken refetches the accountLinks slice"`
- `"reset clears the slice before the anon refetch resolves"` (the mutation test: assert the
  snapshot is empty synchronously after `reset()`, so removing the `clear()` fails it)

### T2 — `hogsend.linkAccount(provider)`: popup + postMessage receiver
_Boundary:_ `packages/js`
_Depends:_ T1

There is currently **zero** `postMessage`, `window.open` or `addEventListener("message")` code in
`packages/js/src` or `packages/react/src`, this task introduces the first, so the whole contract
lives in one file.

- New `packages/js/src/account-links/link-flow.ts`:
  ```ts
  export interface LinkAccountOptions {
    /** Reject with AccountLinkTimeoutError after this long. Default 300_000. */
    timeoutMs?: number;
    /** Popup `windowFeatures`. Default "popup=yes,width=520,height=720". */
    popupFeatures?: string;
  }

  /**
   * The wire contract, OWNED BY PRD 10 (the hosted pages emit it). Mirrored
   * here verbatim; if PRD 10's page changes, this type follows it, never the
   * other way round.
   */
  export type AccountLinkMessage =
    | {
        source: "hogsend";
        type: "account.linked";
        provider: string;
        username: string | null;
        avatarUrl: string | null;
      }
    | {
        source: "hogsend";
        type: "account.link_failed";
        provider: string;
      };

  export function linkAccount(
    deps: {
      transport: Transport;
      identity: IdentityStore;
      store: AccountLinksStore;
      window?: Window;
    },
    provider: string,
    opts?: LinkAccountOptions,
  ): Promise<LinkedAccountDisplay>;
  ```
- Ordering inside `linkAccount`, and the reason for it, written as a comment in the source:
  1. `const popup = win.open("", "hogsend-link-account", features)` **first, synchronously**. A
     popup opened after an `await` has left the user-gesture window and is blocked by every current
     browser. `popup === null` throws `PopupBlockedError` immediately, with a message naming the
     cause ("call linkAccount directly from a click handler").
  2. `const { url } = await transport.post<{ url: string }>("/v1/accounts/link-url", { provider, userToken })`.
     On rejection: `popup.close()`, rethrow.
  3. `const expectedOrigin = new URL(url).origin`. The expected origin is derived from the **minted
     URL**, not from a new config option: that URL arrived over the already-trusted `apiUrl`
     transport, so it is the authoritative statement of where the hosted page lives, and deriving it
     removes a config knob a deploy could get wrong.

     **This is only sound because DECISIONS §15.2 locks what `/v1/accounts/link-url` returns:** an
     ENGINE-origin `<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<state>` URL, never the
     provider's authorize URL. If it returned `https://steamcommunity.com/...`, `expectedOrigin`
     would be Steam's, the success page's `postMessage` from the engine origin would be silently
     dropped by the guard below, and EVERY link would reject with `AccountLinkTimeoutError` despite
     having committed server-side. The fake-`Window` tests below cannot detect that, because they
     never see a real page, so it is pinned by an explicit assertion instead (T2's
     `expectedOrigin equals the apiUrl origin` case) and again on the server in PRD 07 and PRD 09.

     Note that
     `resolveTelemetryUrl` (`packages/js/src/spine/transport.ts:135-140`) proxies only
     `/v1/events`, so `/v1/accounts/*` is always browser-direct and the two origins agree in a
     normal deploy.
  4. `popup.location.href = url`.
  5. Install, and tear down in a single `finally`: the `message` listener, a `popup.closed` poll
     (`setInterval(…, 250)`, the same poll-with-deadline shape as `autoCaptureRef` at
     `packages/js/src/client.ts:319-333`), and the `timeoutMs` timer.
- The guard, in this order, with an early `return` (not a reject) on every failed check so a
  cross-origin bystander message cannot cancel a live flow:
  ```ts
  if (event.origin !== expectedOrigin) return;
  if (event.source !== popup) return;
  const data = event.data as Partial<AccountLinkMessage>;
  if (data?.source !== "hogsend") return;
  if (data.provider !== provider) return;
  ```
- **The closed-popup grace.** PRD 10's success page calls `window.close()` immediately after
  posting, so `popup.closed` flipping true is the normal SUCCESS path, not a cancel. On observing
  the close, start a `CLOSE_GRACE_MS = 400` timer and reject with `AccountLinkCancelledError` only
  if no trusted message has arrived when it fires. Without this the flow reports cancelled on every
  successful link that loses the race, which is a coin-flip bug that will not reproduce reliably.
- New error classes in `packages/js/src/errors.ts` (currently 37 lines, exporting
  `HogsendAPIError`/`RateLimitError`, re-exported at `packages/js/src/index.ts:31`):
  `PopupBlockedError`, `AccountLinkCancelledError`, `AccountLinkTimeoutError` (whose message names
  the empty-allowlist misconfiguration as the likely cause), and `AccountLinkFailedError`.
- Wire `linkAccount` onto the client object in `packages/js/src/client.ts` next to
  `linkedAccounts()`, passing `window` from the closure so tests can inject a fake.
- **On success, refetch before resolving.** The posted payload carries `provider` / `username` /
  `avatarUrl` but not `linkedAt` (see Seams), and the pull plane is authoritative anyway
  (DECISIONS §3.2). So `await accountLinksClient.refetch()`, resolve with the matching entry from
  the refreshed slice, and fall back to the message's fields if the refetch fails. Either way the
  slice is already correct when `onLinked` fires.

Tests — extend `packages/js/src/__tests__/account-links.test.ts` with a fake `Window`
(`{ open: vi.fn(), addEventListener, removeEventListener }`) and a fake popup
(`{ location: { href: "" }, closed: false, close: vi.fn() }`):
- `"opens the popup before awaiting the mint"` (assert `open` was called before `fetch`)
- `"rejects with PopupBlockedError when window.open returns null and never mints"`
- `"navigates the popup to the minted url"`
- `"expectedOrigin equals new URL(apiUrl).origin for a minted url"` — stub `/v1/accounts/link-url` to
  return the engine-origin `/start?t=` URL DECISIONS §15.2 mandates, and assert the guard accepts a
  message from that origin. Then a negative twin: stub the endpoint to return a PROVIDER-origin URL
  and assert the flow times out, so the failure mode is documented in the suite rather than
  discovered in production.
- `"ignores a message from a foreign origin"` (then a good message still resolves, proves the
  guard rejects rather than cancels)
- `"ignores a message whose source is not the popup"`
- `"ignores a message for a different provider"`
- `"rejects with AccountLinkCancelledError when the popup closes and no message follows"`
- `"resolves when the success message arrives just after the popup closes"` (the grace-window
  mutation test: setting `CLOSE_GRACE_MS` to 0 must fail it)
- `"rejects with AccountLinkFailedError on account.link_failed"`
- `"resolves with the refetched entry rather than the posted fields"`
- `"rejects with AccountLinkTimeoutError and closes the popup"`
- `"removes the message listener and clears the poll on every settle path"` (the mutation test for
  the `finally`: parameterize over resolve / cancel / timeout / error)

### T3 — React test harness
_Boundary:_ `packages/react`
_Depends:_ —

`packages/react` today has **zero test files, no `test` script and no vitest devDependency**. A
component task with no way to run a test is a vacuous green by construction, so this comes first.

- `pnpm --filter @hogsend/react add -D vitest` (do not hand-edit `package.json`).
- Add `"test": "vitest run"` to `packages/react/package.json` scripts, matching
  `packages/js/package.json:61`.
- New `packages/react/vitest.config.ts` with `environment: "node"`, mirroring
  `packages/studio/vitest.config.ts`. The repo has no jsdom anywhere; Studio's precedent is to
  assert on static markup from `react-dom/server`, and that is enough for an unstyled button's
  attributes and a11y shape. Say so in a comment so a later contributor does not "fix" it by adding
  jsdom.
- One smoke test that fails if the harness is wrong: `packages/react/src/__tests__/harness.test.tsx`
  rendering `<VisuallyHidden>` (`packages/react/src/components/primitives/visually-hidden.tsx`).

### T4 — `<LinkAccountButton>` + `useLinkedAccounts()`
_Boundary:_ `packages/react`
_Depends:_ T2, T3

- New `packages/react/src/components/account-links/link-account-button.tsx`, `"use client"` at the
  top. Follow the canonical component template `packages/react/src/components/bell/notification-bell.tsx`:
  `forwardRef<HTMLButtonElement, Props>(function LinkAccountButton(props, ref) {…})` (`:77-80`),
  in-house `cn()` (`packages/react/src/lib/cn.ts:17`) and `dataVariants()`
  (`packages/react/src/lib/variants.ts:27`), `asChild` via the in-house `Slot`
  (`packages/react/src/components/primitives/slot.tsx`). Do NOT reach for clsx / cva / tailwind-merge;
  the doc blocks at `lib/cn.ts:1-5` and `lib/variants.ts:1-7` explain why they are banned here.
  ```ts
  export interface LinkAccountButtonClassNames {
    root?: string;
  }

  export interface LinkAccountButtonProps
    extends Omit<ComponentPropsWithoutRef<"button">, "onError"> {
    provider: string;
    onLinked?: (account: LinkedAccountDisplay) => void;
    onError?: (error: unknown) => void;
    asChild?: boolean;
    classNames?: LinkAccountButtonClassNames;
  }
  ```
- **Unstyled is the contract, and it is enforced by absence**: the component emits `hsr-link-account`
  plus `data-hs-state="idle" | "pending"` and `data-hs-provider={provider}`, and **no rule for
  `hsr-link-account` is added to `packages/react/src/styles/styles.css`**. The class is a hook for
  the customer, not a look. This is the one place the component deviates from the bell's five-layer
  surface (`notification-bell.tsx:3-18`), and the deviation is deliberate: the customer's brand is
  their own. Write that reason into the doc block.
- The click handler calls `client.linkAccount(provider)` as its FIRST statement, with no preceding
  `await` or state read that could be async, preserving the gesture window T2 depends on. Guard
  re-entry with a ref so a double click cannot open two popups. Fire `onLinked` / `onError` exactly
  once.
- New `packages/react/src/hooks/use-linked-accounts.ts`, `"use client"`, modelled on
  `packages/react/src/hooks/use-group.ts` (45 lines) and `use-banner.ts:48-58`:
  ```ts
  export interface UseLinkedAccounts {
    accounts: LinkedAccountDisplay[];
    status: "idle" | "loading" | "ready" | "error";
    refresh: () => void;
  }
  export function useLinkedAccounts(): UseLinkedAccounts;
  ```
  Obey the mandatory selector rule at `packages/react/src/hooks/use-store.ts:9-13`: subscribe to the
  stable `order` array and the `status` scalar, then derive `accounts` in a `useMemo` OUTSIDE the
  selector, exactly as `deriveBanners()` does at `use-banner.ts:48-58`. Use an `EMPTY` module const
  as the stable fallback, as `use-group.ts:15` does.
- Throw `"useLinkedAccounts must be used within <HogsendProvider>"` on a null context, matching
  `use-group.ts:29`.
- Export both from `packages/react/src/index.ts` (component block `:26-85`, hooks block `:93-107`).
  **No new tsup entry or exports-map subpath**: the component ships no CSS, so it belongs on the
  root entry rather than earning a granular subpath in `packages/react/tsup.config.ts:14-23`.
- Note the standing law while editing: never an async RSC inside a `"use client"` boundary. Every
  file here carries `"use client"`, and `packages/react/tsup.config.ts:35` re-stamps the banner on
  every output.

Tests — `packages/react/src/__tests__/link-account-button.test.tsx`:
- `"renders a bare button with no styling classes beyond the hooks"`
- `"forwards className and classNames.root"`
- `"renders the child element when asChild is set"`
- `"stamps data-hs-provider"`

## Seams

**None external.** This PRD talks only to Hogsend's own routes.

Three INTERNAL contracts it does not own, all to be settled before T2 is accepted:

1. **The `postMessage` payload is PRD 10's.** This PRD mirrors it; PRD 10 wins any disagreement.
   Verified against PRD 10's success/error `postMessage` criteria as written.
2. **`POST /v1/accounts/link-url` and `GET /v1/accounts/me` are PRD 09's.** The four-key display
   shape here is `serializePublicLinkedAccount` from PRD 09 T2.
3. **An open field-level discrepancy between PRD 10 and PRD 09.**
   PRD 10's success-page criteria say the posted payload is "the same four-field shape
   `GET /v1/accounts/me` returns", but the payload it specifies at `:92-93` carries
   `provider`, `username`, `avatarUrl` and **not** `linkedAt`, which is the fourth key in PRD 09's
   `publicLinkedAccountSchema`. Someone must pick one. This PRD is built to survive either: it
   resolves from the authoritative refetch rather than from the message, so a missing `linkedAt` on
   the wire costs nothing. Flagging it so PRD 10 and PRD 09 do not ship disagreeing.

**Also worth a line in PRD 16's docs**: PRD 10's allowlist is fail-closed silence, so a customer who
never configures their origin sees a link that works server-side and a button that spins until it
times out. That is the first-run failure mode of this whole surface and it should be the first row
of the troubleshooting table.

## Done when

- [ ] `hogsend.linkAccount(provider)` and `hogsend.linkedAccounts()` are on the public `Hogsend`
      type and exported from `packages/js/src/index.ts`.
- [ ] `<LinkAccountButton>` and `useLinkedAccounts()` are exported from `packages/react/src/index.ts`.
- [ ] `packages/react` has a `test` script, a `vitest.config.ts` and at least one passing test.
- [ ] Every origin/source/shape guard in T2 has a test that fails when that single guard line is
      deleted. A guard without such a test is a vacuous green.
- [ ] `styles.css` contains no `hsr-link-account` rule (grep it).
- [ ] Changesets added for `@hogsend/js` and `@hogsend/react` (both are public-surface changes).
- [ ] Gates green from the worktree root:
      ```
      pnpm lint
      pnpm check-types
      cd apps/api && pnpm test
      ```
- [ ] Plus, since this changes a published package's public surface: `pnpm build`.
- [ ] Package-local suites green: `pnpm --filter @hogsend/js test` and
      `pnpm --filter @hogsend/react test`.
- [ ] One conventional commit per task, local only. No push, no PR (DECISIONS §13).

## Implementation Notes
