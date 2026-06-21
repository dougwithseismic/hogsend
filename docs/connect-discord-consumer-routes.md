# Discord connect — consumer-mounted admin routes

`hogsend connect discord` stores four Discord portal values on your instance and
wires the interactions endpoint for you. The two routes that back those steps —
`PUT /v1/admin/connectors/discord/secrets` and
`POST /v1/admin/connectors/discord/wire` — are **NOT shipped by the engine**.
They are mounted by the **consumer app** (the create-hogsend app you deploy) via
`createApp(client, { routes })`.

This doc is the reference + shipped implementation. Without these two routes
mounted, `hogsend connect discord` 404s at the secrets-storage step. Everything
else in the Discord connect flow (connect-info, install URL, member-link, OAuth
callback, the interactions PING/PONG) is engine-shipped and works env-only — see
[`connect-discord.md`](./connect-discord.md) for the operator flow and
[`discord-e2e.md`](./discord-e2e.md) for the full local end-to-end runbook.

The dogfood app (`hogsend-dogfood`, serving `t.hogsend.com`) is the canonical
consumer and **ships these routes today** in
`hogsend-dogfood/src/discord-admin-routes.ts` (mounted from `src/index.ts`).
Paths below assume that app; substitute your own when self-hosting.

---

## Why these are consumer-mounted

The engine is provider-neutral. `@hogsend/engine` ships the GENERIC half of the
connect surface — the connector registry, the OAuth callback, the interactions
route, the member-link route, and the `GET /v1/admin/connectors/discord/connect-info`
projection (`packages/engine/src/routes/admin/connectors.ts`). It ships **no
Discord secrets code**: nothing in the engine reads or writes the Discord bot
token, client secret, or public key, and nothing in the engine calls Discord's
`PATCH /applications/@me`. Those are Discord-specific mutations, so they live on
the Discord side of the boundary — in `@hogsend/plugin-discord` (the helper) and
in your consumer app (the route that calls it). The engine's connectors route
even cross-references this: its handler comment notes the `secrets`/`wire`
routes are "CONSUMER-mounted (the engine ships no Discord code)".

The engine still gives you everything you need to implement them as published,
versioned helpers (so this is **not** blocked on the unpublished connector
runtime):

| Helper | From | Purpose |
| --- | --- | --- |
| `saveDerivedCredential(db, providerId, payload)` | `@hogsend/engine` | encrypt + UPSERT the kind=`derived` credential (AES-256-GCM, full-payload overwrite) |
| `getDerivedCredential(db, providerId)` | `@hogsend/engine` | read + decrypt the current derived credential (`null` when none) |
| `DerivedCredentialPayload` (type) | `@hogsend/engine` | the derived shape; carries the optional Discord fields |
| `patchApplication({ botToken, interactionsEndpointUrl, installParams? })` | `@hogsend/plugin-discord` | `PATCH https://discord.com/api/.../applications/@me` to set the interactions endpoint URL |

`DerivedCredentialPayload` already carries the Discord fields
(`packages/engine/src/lib/provider-credentials.ts`): `discordAppId`,
`discordPublicKey`, `discordClientSecret`, `discordBotToken`, `discordGuildId` —
all optional. The store is a **full-payload overwrite**: merging old and new
fields is the CALLER's job. Always read-merge-write.

### What the engine does NOT export

`requireAdmin`, `requireApiKey`, `hashApiKey`, and `isLoopbackPublicUrl` are
engine-internal and are **not** on the `@hogsend/engine` public surface. A
consumer route cannot `import { requireAdmin }`. Guard the route yourself.

`AppEnv` (the Hono context-variable type, which carries `container`) **is**
exported, so the guard reads the container off the context
(`c.get("container")`) — the same `{ db, env, auth, logger }` the engine's own
admin routes use.

The dogfood's guard (`src/discord-admin-routes.ts`) mirrors the engine's
`requireAdmin` exactly, so it works for the CLI **and** Studio:

- `Authorization: Bearer <key>` → API-key path. First an exact match against
  env `ADMIN_API_KEY` (the legacy single key the CLI sends); otherwise
  `sha256(key)` (hex) is looked up in the `api_keys` table (joined from
  `@hogsend/db`), rejecting revoked (`revoked_at`) and expired (`expires_at`)
  rows. `hogsend connect discord` authenticates with
  `Authorization: Bearer ${ADMIN_API_KEY}`, so the env-key branch is the live
  CLI path; the hashed-key branch lets a minted `hsk_…` key work too.
- No Bearer header → Better-Auth session via
  `container.auth.api.getSession({ headers })` (the Studio cookie path). Any
  authenticated session is an intended admin in the single-tenant model (signup
  is closed after the first user).

---

## Route 1 — `PUT /v1/admin/connectors/discord/secrets`

Stores the four pasted Discord portal values into the derived credential.

- **Auth:** admin (Bearer `ADMIN_API_KEY`).
- **Request body** (this is the **exact** shape the CLI sends —
  `packages/cli/src/lib/connect-discord-flow.ts`, the `deps.http.put(...)`
  call):

  ```json
  {
    "appId": "<Discord application id / OAuth2 Client ID>",
    "publicKey": "<General Information → Public Key>",
    "botToken": "<Bot tab → Reset Token>",
    "clientSecret": "<OAuth2 → Client Secret>"
  }
  ```

  > The live CLI sends the app id under `appId`, NOT `applicationId`. The
  > dogfood's shipped handler reads the app id from **either** `appId` or
  > `applicationId` (`readField(body, "applicationId", "appId")`), so both the
  > CLI wire shape and the spec-named field work. If you write your own handler
  > and only read `applicationId`, the store silently drops the CLI's app id and
  > the install URL never mints — accept `appId`.

- **Behaviour:** read-merge-write via `saveDerivedCredential(db, "discord", {...})`.
  Read the current credential first so a guild id captured on a prior install,
  or a previously-stored field, is never wiped. Map the body fields onto the
  derived shape:

  | body field | derived field |
  | --- | --- |
  | `appId` | `discordAppId` |
  | `publicKey` | `discordPublicKey` |
  | `botToken` | `discordBotToken` |
  | `clientSecret` | `discordClientSecret` |

- **Response:** `{ "ok": true }`.
- **Secret hygiene:** NEVER log the request body, the bot token, the client
  secret, or the public key. No `console.log(body)`, no error message that
  interpolates a field value. The four values are secrets.

Once stored, `GET /v1/admin/connectors/discord/connect-info` mints a non-null
`installUrl` (it now has the app id to build it from), and the CLI re-reads
connect-info to open the one-click bot install.

---

## Route 2 — `POST /v1/admin/connectors/discord/wire`

Wires the interactions endpoint URL onto the Discord application server-side, so
the operator never pastes it into the portal.

- **Auth:** admin (Bearer `ADMIN_API_KEY`).
- **Request body:** none (empty `{}`).
- **Behaviour:**
  1. Resolve the **bot token**: from the just-stored derived credential
     (`getDerivedCredential(db, "discord").discordBotToken`), falling back to
     env `DISCORD_BOT_TOKEN`. If neither is present, fail with a clear error.
  2. Build the **interactions URL**:
     `${API_PUBLIC_URL}/v1/connectors/discord/interactions`
     (strip a trailing slash from `API_PUBLIC_URL` first). On the dogfood that
     resolves to `https://t.hogsend.com/v1/connectors/discord/interactions`.
  3. **Refuse when `API_PUBLIC_URL` is loopback.** Discord validates the
     interactions endpoint by PINGing it **synchronously** during the PATCH, so
     it cannot reach `localhost`/`127.0.0.1`/`0.0.0.0`/`::1`/`*.localhost`.
     Return `409` with body `"api_public_url_unreachable"` — the CLI special-cases
     that exact status+body and surfaces it as the loopback verdict. (The CLI
     also checks this client-side first; the server check is belt-and-suspenders.)
  4. Call
     `patchApplication({ botToken, interactionsEndpointUrl })` from
     `@hogsend/plugin-discord`. It PATCHes `https://discord.com/api/.../applications/@me`
     with `Authorization: Bot <token>`. The helper is idempotent (re-PATCHing the
     same value is a no-op on Discord's side) and throws
     `"Discord PATCH /applications/@me failed (<status>)"` (status only) on a
     non-2xx.

- **Response:** `{ "ok": true }` (or surface
  `patchApplication`'s `{ applicationId, interactionsEndpointUrl }`).
- **Secret hygiene:** status-only logging. NEVER echo Discord's response body —
  it can carry the request back (including the `Bot` token) or the full app
  config. `patchApplication` already throws a status-only message; don't widen
  it. Don't log the resolved bot token.

---

## Shipped implementation — `createApp({ routes })`

The dogfood implements both routes in a single registrar,
`hogsend-dogfood/src/discord-admin-routes.ts`, exporting
`registerDiscordAdminRoutes(app)`. It is mounted from `src/index.ts`:

```ts
// hogsend-dogfood/src/index.ts
import { registerDiscordAdminRoutes } from "./discord-admin-routes.js";

const app = createApp(client, {
  webhookSources,
  routes: registerDiscordAdminRoutes,
});
```

The `routes` callback runs AFTER the engine's built-in routes
(`packages/engine/src/app.ts`, `opts.routes?.(app)`), so these mounts coexist
with the engine-shipped `connect-info` / `interactions` / `oauth/callback`
routes. The routes are mounted **unconditionally** (not gated on the Discord env
being present), so the CLI never 404s regardless of how the instance is
configured. They use plain `app.put` / `app.post` (NOT `.openapi(...)`), which
keeps the secret request bodies OUT of the generated OpenAPI doc.

The registrar's shape, verbatim from the shipped file:

```ts
// hogsend-dogfood/src/discord-admin-routes.ts
import { createHash } from "node:crypto";
import { apiKeys } from "@hogsend/db";
import {
  type AppEnv,
  type DerivedCredentialPayload,
  getDerivedCredential,
  saveDerivedCredential,
} from "@hogsend/engine";
import { patchApplication } from "@hogsend/plugin-discord";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

// Mirrors the engine's (internal) requireAdmin: Bearer API key OR session.
const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    const provided = header.slice(7);
    if (!provided) return c.json({ error: "Unauthorized" }, 401);
    const { env, db } = c.get("container");
    if (env.ADMIN_API_KEY && provided === env.ADMIN_API_KEY) return next();
    const keyHash = createHash("sha256").update(provided).digest("hex");
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!key) return c.json({ error: "Unauthorized" }, 401);
    if (key.expiresAt && key.expiresAt < new Date())
      return c.json({ error: "API key expired" }, 401);
    return next();
  }
  const { auth } = c.get("container");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

export function registerDiscordAdminRoutes(app: OpenAPIHono<AppEnv>): void {
  // PUT /v1/admin/connectors/discord/secrets ---------------------------------
  app.put("/v1/admin/connectors/discord/secrets", requireAdmin, async (c) => {
    const { db, logger } = c.get("container");
    const body = (await c.req.json()) as Record<string, unknown>;
    // The CLI sends `appId`; the spec names it `applicationId` — accept both.
    const applicationId = readField(body, "applicationId", "appId");
    const publicKey = readField(body, "publicKey");
    const botToken = readField(body, "botToken");
    const clientSecret = readField(body, "clientSecret");
    if (!applicationId || !publicKey || !botToken || !clientSecret) {
      return c.json({ error: "…all four values are required" }, 400);
    }
    // Read-merge-write: the derived store is a full-payload OVERWRITE.
    const current =
      (await getDerivedCredential(db, "discord")) ??
      ({} as DerivedCredentialPayload);
    await saveDerivedCredential(db, "discord", {
      ...current,
      discordAppId: applicationId,
      discordPublicKey: publicKey,
      discordBotToken: botToken,
      discordClientSecret: clientSecret,
    });
    logger.info("[discord] stored connect secrets"); // status-only, no values
    return c.json({ ok: true }, 200);
  });

  // POST /v1/admin/connectors/discord/wire -----------------------------------
  app.post("/v1/admin/connectors/discord/wire", requireAdmin, async (c) => {
    const { db, env, logger } = c.get("container");
    const apiPublicUrl = env.API_PUBLIC_URL.replace(/\/+$/, "");
    if (isLoopbackPublicUrl(apiPublicUrl)) {
      return c.json({ error: "api_public_url_unreachable" }, 409);
    }
    const derived = await getDerivedCredential(db, "discord");
    const botToken = derived?.discordBotToken ?? process.env.DISCORD_BOT_TOKEN;
    if (!botToken) return c.json({ error: "bot_token_missing" }, 409);
    const interactionsEndpointUrl = `${apiPublicUrl}/v1/connectors/discord/interactions`;
    try {
      const result = await patchApplication({ botToken, interactionsEndpointUrl });
      logger.info(`[discord] wired interactions endpoint for ${result.applicationId}`);
      return c.json({ ok: true }, 200);
    } catch (error) {
      // patchApplication throws a STATUS-ONLY message — never echo Discord's body.
      const message = error instanceof Error ? error.message : "wire failed";
      logger.warn(`[discord] wire failed: ${message}`);
      return c.json({ error: "wire_failed", message }, 502);
    }
  });
}
```

`readField` reads a trimmed, non-empty string under the first matching key (so
`appId`/`applicationId` are interchangeable). `isLoopbackPublicUrl` is a local
copy of the engine's internal detector (`localhost`, `127.0.0.1`, `0.0.0.0`,
`::1`, `*.localhost`). The handlers read `{ db, env, auth, logger }` off
`c.get("container")`, so they share the same encrypted-at-rest derived store the
engine's `connect-info` route reads.

If you want OpenAPI schemas, the engine's own admin routes use `createRoute()` +
`OpenAPIHono.openapi()` — but plain `app.put` / `app.post` is the smallest
faithful implementation of the CLI contract, and deliberately keeps the secret
bodies out of `/openapi.json`.

---

## Without these routes mounted

`hogsend connect discord` (`packages/cli/src/lib/connect-discord-flow.ts`) drives
the flow in order: `GET connect-info` → `PUT secrets` → re-read connect-info →
`POST wire` → open the install URL. The first two engine routes
(`connect-info`) resolve; the **`PUT secrets`** call hits a route that doesn't
exist and **404s** — the CLI reports `store_failed`. Nothing downstream
(`wire`, install URL minting) runs.

Env-seeding is a partial substitute, not the full operator path. The dogfood's
`seedDiscordDerived(db)` (`hogsend-dogfood/src/discord.ts`, called from
`src/index.ts` when a Discord connector was built) read-merge-writes
`derived.discordAppId` from env `DISCORD_APPLICATION_ID` at boot. That alone is
enough to mint the one-click install URL and gate the member-link route env-only
(connect-info returns a non-null `installUrl`) — but it does **not**:

- store the bot token / client secret / public key into the derived credential
  (only the app id), and
- wire the interactions endpoint (no `PATCH /applications/@me`) — on an env-only
  deploy you paste the Interactions Endpoint URL into the Discord portal
  yourself.

So: env-seeding gets you the install URL; mounting these two routes gets you the
full `hogsend connect discord` one-command flow (paste four values, interactions
endpoint auto-wired). See [`connect-discord.md`](./connect-discord.md) for the
operator runbook and [`discord-e2e.md`](./discord-e2e.md) for the local
end-to-end verification.

---

## Quick reference

| Item | Value |
| --- | --- |
| Secrets route | `PUT /v1/admin/connectors/discord/secrets` |
| Secrets body | `{ appId | applicationId, publicKey, botToken, clientSecret }` (CLI sends `appId`; the handler accepts either) |
| Wire route | `POST /v1/admin/connectors/discord/wire` (empty body) |
| Interactions URL (dogfood) | `https://t.hogsend.com/v1/connectors/discord/interactions` |
| Auth | admin guard: Bearer API key (env `ADMIN_API_KEY` or a hashed `api_keys` row) OR Better-Auth session. CLI sends `Authorization: Bearer ${ADMIN_API_KEY}` |
| Store helper | `saveDerivedCredential` / `getDerivedCredential` (`@hogsend/engine`) |
| Derived fields | `discordAppId`, `discordPublicKey`, `discordBotToken`, `discordClientSecret`, `discordGuildId` |
| Wire helper | `patchApplication` (`@hogsend/plugin-discord`) |
| Loopback rule | refuse `wire` (`409 api_public_url_unreachable`) when `API_PUBLIC_URL` is `localhost`/`127.0.0.1`/`0.0.0.0`/`::1`/`*.localhost` |
| Secret hygiene | never log the body/token/secret/public key; status-only logging on wire |
| Engine does NOT export | `requireAdmin`, `requireApiKey`, `hashApiKey`, `isLoopbackPublicUrl` — guard locally (engine `AppEnv` IS exported) |
| Shipped at | `hogsend-dogfood/src/discord-admin-routes.ts` → `registerDiscordAdminRoutes(app)`, mounted in `src/index.ts` |
