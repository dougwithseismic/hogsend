# Framework recipes — wiring `@hogsend/client` per stack

One shared server-only module, one import per seam. Adjust paths to the
project's conventions (`src/` prefix, path aliases) — the probes in SKILL.md
tell you which recipe applies.

In every recipe the module is the same; only the placement changes:

```ts
import { Hogsend } from "@hogsend/client";

export const hogsend = new Hogsend({
  baseUrl: process.env.HOGSEND_API_URL!,
  apiKey: process.env.HOGSEND_API_KEY!,
});
```

Env (`.env` + the project's `.env.example`):

```bash
HOGSEND_API_URL=https://hogsend.your-company.com
HOGSEND_API_KEY=hsk_...   # ingest-scoped key, server-side only
```

## Next.js — App Router

- **Module:** `lib/hogsend.ts` (or `src/lib/hogsend.ts`). Add
  `import "server-only";` at the top if the project uses the `server-only`
  package — it turns an accidental client-component import into a build error.
- **Call from:** route handlers (`app/**/route.ts`), server actions
  (`"use server"`), and webhook handlers. Never from `"use client"` components.

```ts
// app/api/signup/route.ts
import { hogsend } from "@/lib/hogsend";

export async function POST(req: Request) {
  const { email, name } = await req.json();
  const user = await createUser({ email, name }); // the app's existing logic

  await hogsend.contacts.upsert({
    email,
    userId: user.id,
    properties: { name },
  });
  await hogsend.events.send({ userId: user.id, name: "signup" });

  return Response.json({ ok: true });
}
```

Env note: server-side `process.env.HOGSEND_API_KEY` works out of the box (Next
loads `.env*`). Never add a `NEXT_PUBLIC_` variant.

## Next.js — Pages Router

- **Module:** `lib/hogsend.ts`. **Call from:** `pages/api/**` handlers and
  `getServerSideProps` only.

```ts
// pages/api/signup.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { hogsend } from "../../lib/hogsend";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const user = await createUser(req.body);
  await hogsend.contacts.upsert({ email: user.email, userId: user.id });
  await hogsend.events.send({ userId: user.id, name: "signup" });
  res.status(200).json({ ok: true });
}
```

## Express

- **Module:** wherever the project keeps shared services (`src/lib/hogsend.ts`,
  `src/services/hogsend.ts`). Ensure env is loaded before the module is
  imported (the project's existing `dotenv` setup usually covers this).

```ts
// src/routes/auth.ts
import { Router } from "express";
import { hogsend } from "../lib/hogsend.js";

const router = Router();

router.post("/signup", async (req, res, next) => {
  try {
    const user = await createUser(req.body);
    await hogsend.contacts.upsert({ email: user.email, userId: user.id });
    await hogsend.events.send({ userId: user.id, name: "signup" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
```

## Hono

- **Module:** `src/lib/hogsend.ts`. On Node, `process.env` works directly. On
  edge runtimes (Cloudflare Workers), env arrives per-request via `c.env` — in
  that case construct the client inside the handler (or a middleware) from
  `c.env.HOGSEND_API_URL` / `c.env.HOGSEND_API_KEY` instead of a module-level
  singleton.

```ts
// src/routes/auth.ts (Node runtime)
import { Hono } from "hono";
import { hogsend } from "../lib/hogsend.js";

const auth = new Hono();

auth.post("/signup", async (c) => {
  const body = await c.req.json();
  const user = await createUser(body);
  await hogsend.contacts.upsert({ email: user.email, userId: user.id });
  await hogsend.events.send({ userId: user.id, name: "signup" });
  return c.json({ ok: true });
});
```

## Remix (and React Router v7 framework mode)

- **Module:** `app/lib/hogsend.server.ts` — the `.server.ts` suffix makes the
  bundler exclude it from the client build (this is the framework's own
  server-only mechanism; use it).
- **Call from:** `action` / `loader` exports and resource routes.

```ts
// app/routes/signup.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { hogsend } from "~/lib/hogsend.server";

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const user = await createUser(Object.fromEntries(form));
  await hogsend.contacts.upsert({ email: user.email, userId: user.id });
  await hogsend.events.send({ userId: user.id, name: "signup" });
  return { ok: true };
}
```

## SvelteKit

- **Module:** `src/lib/server/hogsend.ts` — anything under `src/lib/server/`
  is enforced server-only by SvelteKit. Prefer the framework's private env
  module over `process.env`:

```ts
// src/lib/server/hogsend.ts
import { env } from "$env/dynamic/private";
import { Hogsend } from "@hogsend/client";

export const hogsend = new Hogsend({
  baseUrl: env.HOGSEND_API_URL!,
  apiKey: env.HOGSEND_API_KEY!,
});
```

- **Call from:** `+server.ts` endpoints and `+page.server.ts` actions:

```ts
// src/routes/signup/+page.server.ts
import { hogsend } from "$lib/server/hogsend";

export const actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    const user = await createUser(Object.fromEntries(form));
    await hogsend.contacts.upsert({ email: user.email, userId: user.id });
    await hogsend.events.send({ userId: user.id, name: "signup" });
    return { ok: true };
  },
};
```

## Anything else (Fastify, NestJS, plain Node, cron workers)

The pattern is identical: one shared module holding the singleton, imported by
server-side handlers. `@hogsend/client` is a thin wrapper over native `fetch`
(ESM + CJS; declares `engines.node >= 22`), so it runs in any modern Node
server. For NestJS, wrap it in an
injectable provider; for queues/crons, import the same module from the job
handler.

## Hot-path guidance (applies to every framework)

Don't let lifecycle instrumentation take down a signup. Two acceptable shapes:

```ts
// a) awaited, but non-fatal
try {
  await hogsend.events.send({ userId: user.id, name: "signup" });
} catch (err) {
  console.error("hogsend ingest failed", err); // log + continue
}

// b) fire-and-forget with an attached handler (never a bare floating promise)
void hogsend.events
  .send({ userId: user.id, name: "signup" })
  .catch((err) => console.error("hogsend ingest failed", err));
```

For webhook handlers (Stripe, Clerk), prefer (a) awaited — the provider retries
on 5xx, and `idempotencyKey` makes the retry safe.
