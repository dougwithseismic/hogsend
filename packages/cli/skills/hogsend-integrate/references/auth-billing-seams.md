# Auth + billing seams — detection and wiring per provider

How to FIND the place identity is created (or money moves) in the host
codebase, and what to add there. Provider APIs evolve — treat the greps as
"look for", verify against the project's actual code, and confirm the seam
table with the user before editing.

For Clerk, Supabase, Stripe, and Segment there is always a **zero-host-code
alternative**: Hogsend ships inbound webhook presets at
`POST /v1/webhooks/{clerk,supabase,stripe,segment}` on the Hogsend instance
(signature-verified; enabled by setting the provider's secret env var on the
HOGSEND side, e.g. `STRIPE_WEBHOOK_SECRET`). Use the preset when the team wants
the provider's full lifecycle mirrored without touching the host app; use
host-side `@hogsend/client` calls when they want control over event names and
properties. **Pick one per provider — never both** (you'd double-ingest).

## better-auth

**Detect:** `better-auth` in package.json; grep `betterAuth(` for the config
(commonly `lib/auth.ts` / `src/auth.ts`); look for `databaseHooks`.

**Wire:** the `databaseHooks.user.create.after` hook fires once per new user —
the cleanest signup seam:

```ts
import { betterAuth } from "better-auth";
import { hogsend } from "./hogsend"; // the shared server module

export const auth = betterAuth({
  // …existing config…
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await hogsend.contacts.upsert({
            email: user.email,
            userId: user.id,
            properties: { name: user.name },
          });
          await hogsend.events.send({ userId: user.id, name: "signup" });
        },
      },
    },
  },
});
```

## Clerk

**Detect:** `@clerk/nextjs` (or another `@clerk/*` SDK); grep
`clerkMiddleware`. An existing Clerk webhook handler verifies `svix-id` /
`svix-timestamp` / `svix-signature` headers.

**Wire (host-side):** Clerk's reliable signup signal is its `user.created`
webhook (client-side callbacks miss OAuth signups). If the app already has a
Clerk webhook route, add Hogsend calls to its `user.created` branch:

```ts
// inside the verified Clerk webhook handler
if (evt.type === "user.created") {
  const u = evt.data;
  const email = u.email_addresses?.[0]?.email_address;
  await hogsend.contacts.upsert({
    email,
    userId: u.id,
    properties: { firstName: u.first_name, lastName: u.last_name },
  });
  await hogsend.events.send({
    userId: u.id,
    name: "signup",
    idempotencyKey: `clerk_${u.id}_created`,
  });
}
```

**Or (zero host code):** point a Clerk webhook endpoint at the Hogsend
instance's `POST /v1/webhooks/clerk` and set `CLERK_WEBHOOK_SECRET` on the
Hogsend deployment. The preset maps `user.created/updated/deleted` and
`waitlistEntry.created` automatically.

## Supabase Auth

**Detect:** `@supabase/supabase-js` / `@supabase/ssr`; grep
`supabase.auth.signUp`, `auth.admin`, or a database webhook/trigger on
`auth.users`.

**Wire (host-side):** after a successful `signUp` call (server-side — e.g. a
route handler using the server client):

```ts
const { data, error } = await supabase.auth.signUp({ email, password });
if (!error && data.user) {
  await hogsend.contacts.upsert({ email, userId: data.user.id });
  await hogsend.events.send({ userId: data.user.id, name: "signup" });
}
```

Caveat: client-side-only `signUp` calls have no server seam — either move the
call server-side, add a database webhook on `auth.users`, or use the preset.

**Or (zero host code):** point a Supabase database webhook (on `auth.users`
inserts) at the Hogsend instance's `POST /v1/webhooks/supabase` and set
`SUPABASE_WEBHOOK_SECRET` on the Hogsend deployment.

## NextAuth / Auth.js

**Detect:** `next-auth` / `@auth/core`; grep `NextAuth(`. The config commonly
lives in `auth.ts` / `app/api/auth/[...nextauth]/route.ts`.

**Wire:** the `events.createUser` event fires once when the adapter persists a
new user:

```ts
export const { handlers, auth } = NextAuth({
  // …existing config…
  events: {
    async createUser({ user }) {
      await hogsend.contacts.upsert({
        email: user.email ?? undefined,
        userId: user.id,
        properties: { name: user.name },
      });
      await hogsend.events.send({ userId: user.id!, name: "signup" });
    },
  },
});
```

(`events.createUser` requires a database adapter; with pure JWT sessions there
is no persistent user creation moment — instrument the app's own
profile-creation step instead.)

## Stripe (billing)

**Detect:** `stripe` dep; grep `stripe.webhooks.constructEvent` for the webhook
handler, then `checkout.session.completed` / `customer.subscription.` for the
lifecycle branches.

**Wire (host-side):** add events inside the existing verified webhook handler.
ALWAYS pass the Stripe event id as `idempotencyKey` — Stripe retries
deliveries:

```ts
// inside the handler, after constructEvent succeeded
switch (event.type) {
  case "checkout.session.completed": {
    const session = event.data.object;
    await hogsend.events.send({
      email: session.customer_details?.email ?? undefined,
      userId: session.client_reference_id ?? undefined,
      name: "subscription_started",
      eventProperties: {
        amount: session.amount_total,
        currency: session.currency,
      },
      contactProperties: { plan: "pro" },
      idempotencyKey: event.id,
    });
    break;
  }
  case "customer.subscription.deleted": {
    await hogsend.events.send({
      userId: lookupUserIdByCustomer(event.data.object.customer), // app-specific
      name: "subscription_cancelled",
      contactProperties: { plan: "free" },
      idempotencyKey: event.id,
    });
    break;
  }
}
```

Identity note: Stripe events carry a Stripe customer id, not your user id. Use
whatever mapping the app already has (`client_reference_id`, a `userId` in
`metadata`, or a customers table) — at least one of `email`/`userId` is
required on every send.

**Or (zero host code):** add a second Stripe webhook endpoint pointed at the
Hogsend instance's `POST /v1/webhooks/stripe` and set `STRIPE_WEBHOOK_SECRET`
on the Hogsend deployment.

## Hand-rolled auth

**Detect:** grep `signup`, `register`, `createUser`, ORM calls
(`prisma.user.create`, `db.insert(users)`), `INSERT INTO users`.

**Wire:** add the upsert + event immediately after the user row is committed
(after, not before — don't ingest users whose creation then rolls back).

## Output of this step

Before editing, present the seams found:

| Seam | File | Action |
|---|---|---|
| better-auth signup | `src/lib/auth.ts` | add `databaseHooks.user.create.after` |
| Stripe webhook | `app/api/stripe/route.ts` | add events on 2 branches |

…and get a yes. Then wire, then verify (`references/verification.md`).
