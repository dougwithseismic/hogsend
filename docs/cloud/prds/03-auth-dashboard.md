# PRD 03 — Auth, signup + dashboard shell (incl. working-app essentials)

## Goal
Customers can sign up, verify email, create an organization (name, region, plan selection
UI — billing enforcement lands PRD 06), and land in a real dashboard shell showing their
environments/stacks. All working-app essentials exist and are designed.

## Locked decisions (this PRD)
- Better Auth in apps/cloud: email/password + email OTP verification, organization plugin,
  public sign-up ENABLED, cookie prefix `hscloud` (never collide with engine's `hogsend`
  prefix — see auth-cookie-namespace lesson). Session → active org via the org plugin.
- Signup flow: account → verify OTP → create org (name, region, plan pick with trial
  default) → dashboard. `OrgService.create` from PRD 02 is the only org-creation path.
- **Region gating** (DECISIONS §2 cells): the picker offers regions with an `accepting`
  cell for shared-tier plans, any region for dedicated. `OrgService.create` rejects a
  shared-tier org in a region with no accepting cell with a typed error, and assigns
  `cell_id` on success.
- OTP email delivery: console/log transport in dev, Resend transport behind
  `CLOUD_RESEND_API_KEY` (our own key, not a tenant's). Feature-flag real sending.
- Dashboard shell: nav (Environments, Usage, Settings), org switcher, stack status chips
  driven by real `stacks.status`. Empty states designed, not blank.
- Essentials (§7 DECISIONS): account settings (email, password, delete account →
  soft-delete org data + hard-delete auth user), org members/invites/roles UI (Better Auth
  org plugin APIs), Terms + Privacy routed pages with DRAFT stub copy, Scalar API docs
  dev-only.
- All routes server-rendered where possible; client components only where interactive.

## EARS acceptance criteria
- WHEN a visitor completes signup + OTP + org creation, the system SHALL create the Better
  Auth user/org AND the PRD-02 trio (org mirror, production environment, `requested`
  stack), and land them on the dashboard showing that stack.
- WHEN org creation is attempted on a shared-tier plan in a region with no accepting
  cell, the system SHALL reject with a typed error and create nothing.
- WHEN an unauthenticated request hits any dashboard route, the system SHALL redirect to
  login.
- WHEN a member is invited by email, the system SHALL create an invitation acceptable via
  link, arriving as role `member`; only `owner`/`admin` roles SHALL see invite + danger
  surfaces.
- WHEN "Delete account" is confirmed by an org's sole owner, the system SHALL mark the org
  suspended-for-deletion, audit-log it, and sign the user out (hard data deletion is PRD
  12's flow; the UI states this).
- WHEN `/terms` or `/privacy` is requested, the system SHALL render designed pages with
  DRAFT-marked copy.
- WHEN `NODE_ENV=production`, `/api-docs` SHALL 404.

## Tasks
1. **Better Auth wiring + signup/login/OTP screens** — auth instance, drizzle adapter on
   the cloud DB (auth tables migration 0002), screens on ds primitives, dev log-transport
   OTP. _Boundary:_ `apps/cloud`. _Depends:_ PRD 02
2. **Org creation flow + dashboard shell** — create-org step (region/plan), shell layout,
   environments list from real data, status chips, empty states.
   _Boundary:_ `apps/cloud`. _Depends:_ 1
3. **Members/invites/roles + account settings** — org plugin UI surfaces, role gating,
   password change, delete-account flow per EARS.
   _Boundary:_ `apps/cloud`. _Depends:_ 2
4. **Terms/Privacy + API docs + polish pass** — legal stubs, Scalar dev-only over a real
   generated OpenAPI doc of existing routes, loading/error states across the shell.
   _Boundary:_ `apps/cloud`. _Depends:_ 2

## Seams
Legal copy (stub, DRAFT-marked). Real OTP email needs `CLOUD_RESEND_API_KEY` (flagged;
log-transport otherwise).

## Done when
EARS green (route-handler tests + component tests where cheap); gates green; full signup →
dashboard walked in the real browser and screenshotted.

## Implementation Notes
