# PRD — Course paywall (one-time purchase per course)

**Status:** Draft for build · **Author:** generated 2026-06-30 · **App:** `apps/course` (course.hogsend.com)

## 1. Summary

Add a **paywall** to the course site: the first lesson of each course stays free and
public; the rest require a **one-time purchase** of that course via Stripe. This extends
the existing gate — which today is "free, but sign in" — by adding an entitlement
(payment) check. The security boundary, the no-body-leak SSR gate, the free-first-lesson
logic, auth, and the account page already exist; this PRD adds **payment + entitlement**
on top.

Non-goal for v1: subscriptions / all-access pass (kept as a documented future option,
§12).

## 2. Goals & non-goals

**Goals**
- First lesson free + public + indexable (unchanged); lessons 2..N require purchase.
- One-time payment per course via **Stripe Checkout** (hosted — no card handling, no PCI).
- Entitlement is durable, idempotent, and the gate is **default-closed** (no payment →
  no body, ever).
- Ships **gracefully**: if Stripe env is absent, the site falls back to today's
  "free with sign-up" gate (mirrors the existing `ingestConfigured()` pattern). No
  big-bang switch; reversible by unsetting env.

**Non-goals (v1)**
- Subscriptions, all-access bundle, coupons/discount codes, regional pricing, tax/VAT
  collection (Stripe Tax), refund self-service, gifting, team/seat licences.

## 3. Current state (what we're building on)

- **Gate:** `apps/course/app/learn/[[...slug]]/page.tsx` — RSC, `force-dynamic`. The
  security boundary: an anon request to a gated lesson returns `<LessonGate>` **before**
  the MDX body is read. Today:
  ```tsx
  if (!isFreeLesson(slugs)) {
    const session = await getSession();
    if (!session) return <LessonGate … />;
    await ensureEnrollment(…);
  }
  ```
- **Gating helpers:** `apps/course/lib/gating.ts` — `isFreeLesson()` (free = lexically
  first slug per course, dynamic), `getSession()`, `ensureEnrollment()`,
  `recordLessonProgress()`.
- **DB:** course's own Postgres (postgres-js + drizzle). Tables: Better Auth core
  (`user`/`session`/`account`/`verification`) + `enrollment` + `lesson_progress`.
  Migrations via `db:generate` (committed) + the standalone `migrate.bundle.mjs`
  pre-deploy runner.
- **Events:** `apps/course/lib/events.ts` forwards `course.*` to the dogfood ingest via
  `forwardToIngest(...)`. **Identity rule (load-bearing):** identify by **email only**;
  the Better Auth id rides as `contactProperties.courseUserId`, NEVER as the ingest
  top-level `userId`.
- **Env:** `apps/course/lib/env.ts` — fail-closed `runtimeRequired()` with build-phase
  placeholders.
- **Course metadata:** `apps/course/lib/courses.ts` (`CourseMeta`, `getCourse()`).
- **Sign-in:** `app/(auth)/sign-in/page.tsx` already honours `?next=<path>`.

## 4. User flows

### 4.1 Buy (happy path)
1. Anon hits gated lesson → `<LessonGate>` "sign in" wall (unchanged).
2. After sign-in (magic link), returns to the lesson → now sees **`<Paywall>`** (signed
   in, not yet purchased): course title, price, "Buy — $X", bullets on what's included.
3. Click Buy → `POST /api/checkout` (server action/route) creates a Stripe **Checkout
   Session** (`mode: "payment"`, the course's price, `client_reference_id = user.id`,
   `customer_email = user.email`, `metadata.courseSlug`), redirects to Stripe.
4. User pays on Stripe's hosted page.
5. Stripe → `success_url` = the lesson URL (`?purchase=success`). In parallel, Stripe
   fires `checkout.session.completed` → our **webhook** writes the `purchase` row.
6. On return, the gate now passes (`hasPurchased` true) → lesson body renders. (If the
   webhook hasn't landed in the ~1s round-trip, see §8.3 "pending" handling.)

### 4.2 Already owned
- Signed in + purchased → gate passes silently, body renders. Overview/account show
  "Owned".

### 4.3 Cancel
- Stripe `cancel_url` = the lesson URL (`?purchase=cancelled`) → back to `<Paywall>`,
  soft notice. No row written.

### 4.4 Refund (admin-initiated in Stripe dashboard)
- Stripe fires `charge.refunded` / `refund.created` → webhook sets the purchase row
  `status = "refunded"`; `hasPurchased` returns false → access revoked. (v1: refunds are
  manual in the Stripe dashboard; we just honour the resulting webhook.)

## 5. Data model

New table `purchase` (course's DB), drizzle:

```ts
export const purchase = pgTable(
  "purchase",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    courseSlug: text("course_slug").notNull(),
    status: text("status").notNull().default("paid"),     // paid | refunded
    stripeCustomerId: text("stripe_customer_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    amount: integer("amount"),                            // minor units, for records
    currency: text("currency"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("purchase_user_course_uq").on(t.userId, t.courseSlug),       // one active grant per user×course
    uniqueIndex("purchase_checkout_session_uq").on(t.stripeCheckoutSessionId), // webhook idempotency
  ],
);
```

- `purchase_user_course_uq` → `hasPurchased(userId, courseSlug)` is one indexed lookup.
- `purchase_checkout_session_uq` → webhook is idempotent on Stripe's session id
  (insert `onConflictDoNothing`).

## 6. Course price config

- Add to `CourseMeta` (lib/courses.ts): `priceLabel: string` (e.g. `"$49"`, display only)
  and a logical key. The **actual Stripe price id is environment-specific** (test vs
  live), so it lives in **env**, mapped by course slug:
  - `STRIPE_PRICE_GROWTH_WITH_POSTHOG = price_xxx`
  - A small `priceIdForCourse(slug)` resolves slug → env price id.
- One course today, so this is one mapping. The map keeps test/live keys out of git.

## 7. Files to add / change

| File | Change |
|---|---|
| `lib/db/schema.ts` | + `purchase` table (§5) |
| `lib/db/migrations/*` | generated migration (`pnpm db:generate`) |
| `lib/env.ts` | + `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` (optional, graceful) |
| `lib/stripe.ts` *(new)* | Stripe client singleton; `paywallConfigured()` (mirrors `ingestConfigured()`) |
| `lib/entitlements.ts` *(new)* | `hasPurchased(userId, courseSlug)`; `recordPurchase(...)`; `revokePurchase(...)` |
| `lib/gating.ts` | gate gains the entitlement clause (when paywall configured) |
| `lib/courses.ts` | + `priceLabel`; `priceIdForCourse()` |
| `app/learn/[[...slug]]/page.tsx` | +3 lines: `if (!hasPurchased) return <Paywall/>` |
| `components/auth/paywall.tsx` *(new)* | wall for signed-in-not-purchased (clone of `LessonGate`) |
| `app/api/checkout/route.ts` *(new)* | create Checkout Session, 303 redirect to Stripe |
| `app/api/stripe/webhook/route.ts` *(new)* | verify + handle `checkout.session.completed`, `charge.refunded` |
| `lib/events.ts` | + `emitPurchased(user, courseSlug, …)` (email-only identity rule) |
| `app/(catalog)/account/page.tsx` | show Owned vs Buy per course |
| `app/(catalog)/[course]/page.tsx` (overview) | "Buy"/"Owned" CTA + price |
| `package.json` | `pnpm add stripe` |

The **gate change** (the security-critical bit):

```tsx
if (!isFreeLesson(slugs)) {
  const session = await getSession();
  if (!session) return <LessonGate … />;            // not signed in
  if (paywallConfigured() && !(await hasPurchased(session.user.id, slugs[0])))
    return <Paywall course={slugs[0]} lessonUrl={page.url} … />;  // signed in, not paid
  await ensureEnrollment(…);
}
```

`paywallConfigured()` gating the clause = the graceful fallback: no Stripe env → behaves
exactly like today (free with sign-up).

## 8. Security & correctness

1. **Default-closed gate.** The entitlement check is in the RSC before the body is read,
   same boundary as today. No purchase → `<Paywall>` returned → MDX never rendered. Add a
   test asserting a signed-in-unpaid request's HTML contains zero gated body.
2. **Webhook signature.** `/api/stripe/webhook` reads the **raw body** via
   `await req.text()` (App-Router footgun: never parse JSON first) and verifies with
   `stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET)`. Bad signature →
   400, no DB write. Fail-closed when `STRIPE_WEBHOOK_SECRET` unset.
3. **Idempotency.** Stripe retries deliveries. Insert the `purchase` row
   `onConflictDoNothing` on the checkout-session unique index; emit `course.purchased`
   only when a new row is actually inserted (same pattern as `ensureEnrollment`).
4. **Entitlement is server-derived.** `hasPurchased` reads the DB by the **session**
   user id — never trusts a query param. `?purchase=success` only triggers a soft
   "processing…" UI; access is granted by the row, not the URL.
5. **Identity rule.** `emitPurchased` follows events.ts: email-only top-level, auth id in
   `contactProperties.courseUserId`. (Avoids the documented external_id lockout.)
6. **Financial boundary.** All code is in-repo; **Doug** creates the product/price in the
   Stripe dashboard, adds the secret keys to Railway, and registers the webhook endpoint.
   No financial credentials are entered by the assistant. Test mode first.

## 9. Events / analytics

- `course.purchased` → dogfood ingest on a confirmed (new-row) purchase:
  `eventProperties: { source, course, courseTitle, amount, currency }`,
  `contactProperties: { courseUserId }`, email-only identity, idempotency key
  `course-purchased-<userId>-<courseSlug>`.
- Enables a Phase-4 receipt / onboarding journey in the engine (out of scope here).
- Optional: a PostHog client event `course_purchase_started` on Buy click for funnel.

## 10. Stripe configuration (Doug's 2-minute setup)

**Test mode first**, then repeat in live:
1. Create a **Product** "Measure, Keep, and Grow" with a **one-time Price** (e.g. $49 USD)
   → copy the `price_…` id.
2. Add Railway env to `hogsend-course`: `STRIPE_SECRET_KEY` (sk_test_…),
   `STRIPE_PRICE_GROWTH_WITH_POSTHOG` (price_…). (`STRIPE_WEBHOOK_SECRET` after step 3.)
3. Add a **webhook endpoint** → `https://course.hogsend.com/api/stripe/webhook`, events:
   `checkout.session.completed`, `charge.refunded` → copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`.
4. Local dev/testing: `stripe listen --forward-to localhost:3006/api/stripe/webhook` +
   `stripe trigger checkout.session.completed`.

## 11. Open product decisions (need Doug)

- **Price & currency** — recommend **$49 USD one-time** for the one course (placeholder;
  your call). Affects only the Stripe price + the `priceLabel`.
- **Free-lesson scope** — keep "first lesson free" (recommended). Could later make N
  lessons free.
- **Existing readers** — anyone who's already created an account stays free? Recommend:
  paywall applies to everyone going forward (no prior purchasers exist yet, so moot).

## 12. Future (explicitly out of v1)

- **Subscription / all-access** via `@better-auth/stripe` (handles customer + subscription
  lifecycle + webhooks turnkey). Swap `hasPurchased` for `hasActiveSubscription || owns`.
- Coupons / launch discount codes (Stripe promotion codes — a one-line Checkout flag).
- Stripe Tax, regional pricing, gifting, team seats, refund self-service, dunning.

## 13. Acceptance criteria

- [ ] Anon → gated lesson: sign-in wall, no body leak (existing).
- [ ] Signed-in, unpaid → `<Paywall>` with price + Buy; **no body leak** (HTML asserted).
- [ ] Buy → Stripe Checkout → pay (test card) → webhook writes row → lesson renders.
- [ ] Reload / second device: access persists (DB-backed, not cookie).
- [ ] Duplicate webhook delivery → exactly one row, one `course.purchased`.
- [ ] Bad webhook signature → 400, no write.
- [ ] Refund in dashboard → access revoked.
- [ ] Stripe env unset → site falls back to free-with-sign-up (no crash).
- [ ] `next build` green; migration runs in pre-deploy.

## 14. Build phases

1. **Schema + entitlement core** — `purchase` table + migration, `lib/stripe.ts`,
   `lib/entitlements.ts`, `paywallConfigured()`. Gate clause + `<Paywall>` (fallback-safe).
2. **Checkout + webhook** — `/api/checkout`, `/api/stripe/webhook` (raw body, signature,
   idempotency), `emitPurchased`.
3. **Surfaces** — overview + account "Buy/Owned", `?purchase=success` soft state.
4. **Tests + verify** — gate/no-leak test, webhook idempotency test, `next build`, local
   `stripe listen` end-to-end in test mode.
5. **Ship** — PR, CI, merge; Doug adds Stripe product/keys/webhook; flip to live.

**Estimate:** ~½–1 day of build (phases 1–4); deploy + Stripe setup ~30 min.
