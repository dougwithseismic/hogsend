# PRD 15 — Studio panel

## Goal

Make a player's linked accounts visible to an operator without giving them a way to change anything.
A read-only panel on the contact-detail drawer listing live links with provider, username, `method`
provenance, `linkedAt` and `tokensRevokedAt`, plus a reverse-lookup page answering "who is steamid64
X?". Two boundaries: read-only admin routes in the engine, and the Studio UI over them.

## Locked decisions specific to this PRD

- **Observe-only. No authoring UI in Studio** (DECISIONS §12). Authoring stays in the data plane.
  The panel has no unlink button, no relink, no token actions. `groups-view.tsx:244-255` states the
  same law for groups; copy that doc-comment form.
- **Reverse lookup is a PULL-plane job** (DECISIONS §3.2): the pull plane is authoritative and
  explicitly lists "reverse lookup" among its jobs. This PRD surfaces it, it does not invent a
  second source of truth.
- **`tokensRevokedAt` is exposed on the read surface** (DECISIONS §10). It is the ONLY signal a
  customer gets that a grant died, since `account.updated` was deliberately rejected (DECISIONS §8).
  So the panel showing it is not decoration, it is the whole substitute for an event.
- **`method` provenance is a first-class column**: `"oauth"` means a completed hosted callback,
  `"import"` means the insert-only carve-out (DECISIONS §6.2). An operator looking at a disputed
  account needs to know which one proved it.
- Sealed tokens NEVER cross an HTTP boundary, mirroring
  `packages/engine/src/routes/admin/provider-credentials.ts:18-22`.
- **This PRD needs its OWN `/v1/admin/accounts` router behind `requireAdmin`** (BACKLOG row 15).
  Studio cannot call PRD 09's scope-guarded data plane: it authenticates with a Better Auth session
  cookie only (`packages/studio/src/lib/api.ts:48` sets `credentials: "include"` and sends no
  `Authorization` header anywhere), and `packages/engine/src/routes/admin/campaigns.ts:3` states the
  consequence outright: *"Studio cannot use the `hsk_`-keyed data-plane."* `requireAdmin`
  (`packages/engine/src/middleware/require-admin.ts:11`) accepts EITHER a `full-admin`-scoped bearer
  key OR a session cookie; `requireScope("accounts")` accepts only the former. So T1 is a new router
  mirroring exactly what `routes/admin/groups.ts` is to the secret-key `/v1/groups` router. **The
  dependency on PRD 09 is for the store and the row shape, not for the HTTP surface.** This
  contradicts no locked decision: DECISIONS §3.1 already assigns Studio the observe-only panel, and
  §3.2's PULL plane stays the single source of truth because the admin router reads the same
  `linked_accounts` rows.
- **`version` is a `bigint` carried as a STRING** (DECISIONS §5.1) anywhere this surface exposes it.
  Never `parseInt`; serialize with `String(row.version)`.

## Acceptance criteria (EARS)

- WHEN an operator opens a contact in Studio the system SHALL show a "Linked accounts" section
  listing every LIVE link for that contact with provider, username, `method`, `linkedAt` and, when
  set, `tokensRevokedAt`.
- WHEN a contact has no linked accounts the system SHALL render a one-line muted message in place of
  the table, not a page-level `EmptyState` (the drawer's other sections use a plain `<p>`; see
  `contact-detail-drawer.tsx:401-407`).
- WHEN the linked-accounts sub-query fails the system SHALL degrade to a one-line "Could not load
  linked accounts" and SHALL NOT fail the whole drawer, matching
  `contact-detail-drawer.tsx:430-453`.
- WHEN an operator submits a `(provider, providerUserId)` pair to the reverse-lookup view the system
  SHALL show the owning contact, the `method`, the `linkedAt`, and a link through to that contact.
- WHEN the reverse lookup finds no owner the system SHALL render `EmptyState` ("no account matches
  that id"), NOT `ErrorState`. A 404 is a normal answer here; `ErrorState` is reserved for transport
  failures.
- WHEN the reverse lookup matches a link that has been unlinked the system SHALL say so explicitly
  rather than reporting no match, since "this used to belong to someone" is the operationally
  interesting answer during a dispute.
- WHEN any admin endpoint added here returns a linked account the response SHALL contain no token
  material of any kind, sealed or otherwise.
- WHEN the panel or the lookup renders the system SHALL compose existing Studio primitives; a
  bespoke table, a hand-rolled badge or ad-hoc spacing is a fail. Functional-but-ugly is a fail.
- WHEN routes are registered the literal `lookup` path SHALL be registered BEFORE any
  `{provider}/{providerUserId}` param route, in both the engine router and the Studio router, per
  the law documented at `packages/engine/src/routes/admin/groups.ts:722-723` and
  `packages/studio/src/routes/index.tsx:133-134`.

## Tasks

### T1 — Read-only admin routes `/v1/admin/accounts`
_Boundary:_ `packages/engine`
_Depends:_ PRD 03, PRD 09

**Studio cannot call PRD 09's data-plane routes**, so this is a new router, not a reuse: the SPA is
cookie-authed and the data plane is `hsk_`-scoped (see "Locked decisions" above). This router is to
`/v1/accounts` what `routes/admin/groups.ts` is to `/v1/groups`.

- New `packages/engine/src/routes/admin/accounts.ts`, mirroring
  `packages/engine/src/routes/admin/groups.ts` line for line:
  - Header comment stating the two laws, in the form of `groups.ts:22-28`: this router inherits the
    admin router's `requireAdmin` guard and never re-auths, and it is READ-ONLY (no mutation route
    exists here; unlinking is the data plane's).
  - `import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";`, `z` comes from
    `@hono/zod-openapi`, never from `zod` directly, and every relative import carries `.js`.
  - Module-level schemas above the routes: `linkedAccountSchema` (all dates `z.string()` ISO,
    `version` a `z.string()` because the column is a `bigint` that exceeds
    `Number.MAX_SAFE_INTEGER`, open bags `z.record(z.string(), z.unknown())`, nullables via
    `.nullable()`), and the shared
    `const errorSchema = z.object({ error: z.string() });`.
  - A pure `serializeLinkedAccount(row)` that `.toISOString()`s every `Date`, writes
    `String(row.version)` (never `Number(...)`), and, critically, does not project `tokens` at all.
    The column must not be in the `db.select({...})` projection either, so a future edit to the
    serializer cannot leak it.
  - Reuse `escapeLike` (`groups.ts:195-197`) for any username search so a search string cannot widen
    its own LIKE match.
  - Every read filters the soft-delete and the live-link predicate
    (`isNull(contacts.deletedAt)`, `isNull(linkedAccounts.unlinkedAt)` where appropriate).
- Three routes, in this registration order:
  ```ts
  // GET /v1/admin/accounts/lookup?provider=&providerUserId=
  // -> { account: LinkedAccount | null, contact: ContactSummary | null,
  //      state: "linked" | "unlinked" | "unknown" }
  const lookupRoute = createRoute({ method: "get", path: "/lookup", tags: ["Admin — Account links"], … });

  // GET /v1/admin/accounts/contacts/{contactId}
  // -> { accounts: LinkedAccount[] }
  const listForContactRoute = createRoute({ method: "get", path: "/contacts/{contactId}", … });

  // GET /v1/admin/accounts?limit=&offset=&provider=&search=
  // -> { accounts, total, limit, offset }
  const listRoute = createRoute({ method: "get", path: "/", … });
  ```
  Path params use `{brace}` syntax. `limit: z.coerce.number().min(1).max(100).default(50)`,
  `offset: z.coerce.number().min(0).default(0)`, matching `groups.ts:541-542`. The list response is
  the house paginated shape `{ <collection>, total, limit, offset }`.
  `lookupRoute` returns `state: "unlinked"` with the row when the newest row for that
  `(provider, providerUserId)` is unlinked, which is what the acceptance criterion above requires.
- `accountsRouter` is one fluent `new OpenAPIHono<AppEnv>().openapi(...).openapi(...)` chain, with
  `lookupRoute` first and a comment above it in the form of `groups.ts:722-723` naming the
  counterfactual ("otherwise the literal `lookup` is captured as a provider").
- Register in `packages/engine/src/routes/admin/index.ts` alongside
  `adminRouter.route("/groups", groupsRouter)` (`:69`), keeping the alphabetized import block.

Tests — `packages/engine/src/routes/admin/accounts-wire.test.ts`, following the
`<domain>-<concern>.test.ts` naming already used there (`domain-conflict.test.ts`,
`impact-wire.test.ts`), plus a DB-backed suite at
`apps/api/src/__tests__/admin-account-links.test.ts` built with the
`createHogsendClient()` + `createApp(container)` + `app.request()` idiom from
`apps/api/src/__tests__/health.test.ts:4-5`:
- `"lists live links for a contact"`
- `"never returns token material"`. Assert the JSON body has no `tokens` key at ANY depth. This is
  the mutation test for the projection: adding `tokens` to the select must fail it.
- `"reverse lookup resolves the owning contact"`
- `"reverse lookup reports state unlinked for a released account"`
- `"reverse lookup 404s cleanly for an unknown id"`
- `"the literal /lookup path is not captured as a provider param"`
- `"requires admin"` (unauthenticated request is rejected)
- `"a session cookie reaches the router"` — the reason this router exists at all (BACKLOG row 15).
  It must FAIL if the router is moved behind `requireScope("accounts")`.
- `"version is serialized as a string"`, including a row whose version exceeds
  `Number.MAX_SAFE_INTEGER`, asserted on the raw response text so a `Number()` in the serializer
  fails it

### T2 — The contact-detail panel
_Boundary:_ `packages/studio`
_Depends:_ T1

There is no contact-detail *page* in Studio; contact detail is a right-anchored drawer.

- `packages/studio/src/lib/admin-api.ts`, add a `// --- Account links ---` banner section next to
  the contacts section (`:956`), exporting:
  ```ts
  export type LinkedAccountMethod = "oauth" | "import";
  export interface AdminLinkedAccount {
    id: string;
    provider: string;
    providerUserId: string;
    username: string | null;
    method: LinkedAccountMethod;
    linkedAt: string;
    unlinkedAt: string | null;
    tokensRevokedAt: string | null;
  }
  export function listContactLinkedAccounts(contactId: string): Promise<{ accounts: AdminLinkedAccount[] }>;
  export function lookupLinkedAccount(provider: string, providerUserId: string): Promise<AccountLookupResult>;
  ```
  `encodeURIComponent` every path segment, as `getGroup` does at `admin-api.ts:932-934`.
  Add query keys to the central `qk` object (`admin-api.ts:2220`), matching the existing
  `contactActivity` / `contactTimeline` naming at `:2260-2261`:
  ```ts
  contactLinkedAccounts: (id: string) => ["contact-linked-accounts", id] as const,
  linkedAccountLookup: (provider: string, providerUserId: string) =>
    ["linked-account-lookup", provider, providerUserId] as const,
  ```
- `packages/studio/src/views/contacts/contact-detail-drawer.tsx`, add a fifth `useQuery` beside the
  existing four (`:106-125`), `enabled: open`, and insert a new `<section>` **at `:295`**, between
  the close of the Groups section (`:294`) and the Revenue IIFE (`:296`). Groups is the existing
  identity-adjacent observe-only section, so linked accounts belongs immediately after it.
- **Composed from existing primitives only.** Concretely:
  - `<section>` + `<h3 className="eyebrow mb-3 text-white/50">Linked accounts</h3>`, the drawer's
    own section header idiom, not `PageHeader`.
  - `Table`, `TableHeader`, `TableRow`, `TableHead`, `TableBody`, `TableCell` from
    `@/components/ui/table`.
  - `Badge` from `@/components/ui/badge` for the `method` chip (`variant="secondary"` for `oauth`,
    `variant="outline"` for `import`) and for a `destructive` "Token revoked" chip when
    `tokensRevokedAt` is set.
  - The `providerUserId` in the `<code>` chip idiom copied from `groups-view.tsx:503-505`.
  - `Skeleton` from `@/components/ui/skeleton` while pending.
  - `formatDateTime` from `@/lib/format` for `linkedAt` / `tokensRevokedAt`.
  - Check `packages/studio/src/components/brand-icons.tsx` for an existing Steam or Twitch mark
    before drawing any new glyph.
  - `cn()` from `@/lib/utils` for class merging. Tailwind v4 tokens only
    (`--color-accent`, `--color-hairline-faint` from `packages/studio/src/index.css:29-60`); no
    literal hex values.
- **Export the pure helpers from the view module** so they are testable, since Studio's only test
  convention is `renderToStaticMarkup` plus unit tests over exported pure functions
  (`packages/studio/src/__tests__/return-path-card.test.tsx:14-17`):
  ```ts
  export function linkedAccountStatusOf(a: AdminLinkedAccount): "live" | "revoked" | "unlinked";
  export function methodLabelOf(method: LinkedAccountMethod): string;
  ```

Tests — `packages/studio/src/__tests__/linked-accounts-panel.test.tsx`:
- `"linkedAccountStatusOf reports revoked when tokensRevokedAt is set"`
- `"linkedAccountStatusOf prefers unlinked over revoked"`
- `"methodLabelOf distinguishes oauth from import"`
- `"renders a row per live link"` (static markup)
- `"renders the muted empty line, not an EmptyState, when there are none"`

### T3 — The reverse-lookup view
_Boundary:_ `packages/studio`
_Depends:_ T2

Genuinely new ground: Studio has no "search box to single result" surface today. Every existing
search is a debounced list filter. The closest precedent is `ContactPicker`
(`packages/studio/src/components/contact-picker.tsx:35`), whose two-pane "results left, single
profile card right" shape and header rationale (`:19-34`) are worth reading before writing this.

- New `packages/studio/src/views/account-links/account-lookup-view.tsx`:
  ```ts
  export function AccountLookupView({
    provider, providerUserId,
  }: { provider: string | null; providerUserId: string | null }): ReactNode;
  ```
  Router-agnostic props, read from the route (the law at
  `packages/studio/src/routes/index.tsx:169-170`).
- Composition: `PageHeader` (`@/components/states`) → a `Card` holding a provider `Combobox`
  (options from the admin provider list) + an `Input` with a `Search` lucide icon + a submit
  `Button` → the result region.
- The result region's state ladder, following `group-detail-view.tsx:59-63` and
  `groups-view.tsx:433-538`:
  - not yet submitted → a muted instruction line
  - `isPending` → `TableSkeleton`
  - `isError` → `ErrorState` with `onRetry`
  - resolved with no match → `EmptyState` (icon, title "No account matches that id")
  - resolved → a `Card` with three `StatCard` tiles (provider, method, state) in the
    `grid gap-4 sm:grid-cols-2 lg:grid-cols-3` shape from `group-detail-view.tsx:80-94`, then the
    owning-contact row
- The owning contact links to the existing contact surface, not a new one:
  `navigate({ to: "/contacts", search: { contact: id } })`, hitting the deep link declared at
  `packages/studio/src/routes/index.tsx:177-190`. Do not invent a second contact page.
- Route wiring in `packages/studio/src/routes/index.tsx`: a `createRoute` for `/accounts/lookup`
  with `validateSearch` reading `provider` and `providerUserId`, added to the `addChildren` array
  (`:216-241`). If a `/accounts/$provider/$providerUserId` route is ever added it must come AFTER
  this one, and a comment in the form of `:133-134` should say so now so the next contributor does
  not reorder it.
- Nav entry in `packages/studio/src/components/layout/nav.ts:29-48`. Place it adjacent to Contacts
  (`:43`) since it is an identity tool, with a lucide icon consistent with the existing set.

Tests — `packages/studio/src/__tests__/account-lookup-view.test.tsx`:
- `"renders the instruction state before a query is submitted"`
- `"renders EmptyState, not ErrorState, for a no-match result"` (the mutation test for the
  404-is-normal rule)
- `"renders the unlinked state distinctly from no-match"`

### T4 — Document the surface
_Boundary:_ `CLAUDE.md`
_Depends:_ T1, T2, T3

Add the account-links Studio + admin-route lines to the repo `CLAUDE.md`, mirroring the two lines
that already do this job for groups: `CLAUDE.md:197` (the engine's read-only admin endpoints) and
`CLAUDE.md:201` (the observe-only Studio views). One line each, same register, naming the real file
paths. This is how a `/docs`-less surface stays discoverable in this repo.

## Seams

**None.** Everything here reads rows Hogsend already owns. No external credential, no third-party
call, no human ask. This PRD is fully completable offline, which is why it is a good one to run in
parallel with the credential-blocked ones.

## Done when

- [ ] `GET /v1/admin/accounts/lookup`, `/v1/admin/accounts/contacts/{contactId}` and
      `GET /v1/admin/accounts` exist behind `requireAdmin` and appear in the OpenAPI document.
- [ ] `lookup` is registered before any param route, in both routers, each with the counterfactual
      comment.
- [ ] A test asserts no token material appears anywhere in any admin response body, and it fails if
      `tokens` is added back to the select projection.
- [ ] The contact drawer shows the panel at `contact-detail-drawer.tsx:295`, and a failing
      sub-query degrades to one muted line rather than breaking the drawer.
- [ ] The reverse-lookup view is reachable from the sidebar and links through to
      `/contacts?contact=<id>`.
- [ ] No mutation control exists anywhere in the new UI. Grep the two new view files for
      `useMutation`, `Button` with a destructive action, and `ConfirmDialog`: all three must be
      absent. Observe-only is a property of the code, not an intention.
- [ ] The panel and the lookup view are screenshotted against the REAL Studio (not a mockup) and the
      images shown before the work is called done. A UI surface that has not been looked at has not
      been reviewed.
- [ ] The admin router is reachable with a Studio session cookie and carries no `requireScope`
      guard, with a test that fails if one is added.
- [ ] `CLAUDE.md` carries the two new lines.
- [ ] Changesets added for `@hogsend/engine` and `packages/studio`.
- [ ] Gates green from the worktree root:
      ```
      pnpm lint
      pnpm check-types
      cd apps/api && pnpm test
      ```
- [ ] Plus, since this changes the engine's public route surface: `pnpm build`.
- [ ] `pnpm --filter @hogsend/studio test` green.
- [ ] One conventional commit per task, local only. No push, no PR (DECISIONS §13).

## Implementation Notes
