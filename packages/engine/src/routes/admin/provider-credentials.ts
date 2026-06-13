import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  deleteAllProviderCredentials,
  getProviderCredential,
  ProviderCredentialDecryptError,
  type ProviderCredentialMeta,
  saveProviderCredential,
  toCredentialMeta,
} from "../../lib/provider-credentials.js";
import { errorSchema } from "../../lib/schemas.js";

/**
 * Admin provider-credential management. Mounted at
 * `/v1/admin/provider-credentials`, it inherits `requireAdmin` + `rateLimit`
 * + `auditMiddleware` from the admin router root — no per-route auth here.
 *
 * INVARIANT: decrypted token material NEVER appears in any HTTP response —
 * this router returns meta only. (The audit middleware is body-blind, so a
 * PUT body carrying tokens is not persisted to `audit_logs` either.)
 */

const providerIdParam = z.object({
  providerId: z.string().min(1).max(100),
});

// The canonical OAuth credential payload (SYNTHESIS §0) — keep textually
// identical to the token manager's runtime parse.
const oauthPayloadSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  tokenEndpoint: z.string().url(),
  clientId: z.string().url(),
  scopes: z.array(z.string()).default([]),
  scopedTeams: z.array(z.number().int()).default([]),
  scopedOrganizations: z.array(z.string()).default([]),
});

const putBodySchema = z.object({
  kind: z.literal("oauth").default("oauth"),
  payload: oauthPayloadSchema,
});

// Wire meta — Dates serialized to ISO strings. Token material never appears.
const credentialMetaSchema = z.object({
  providerId: z.string(),
  kind: z.literal("oauth"),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  scopedTeams: z.array(z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const upsertRoute = createRoute({
  method: "put",
  path: "/{providerId}",
  tags: ["Admin — Provider Credentials"],
  summary: "Store (upsert) a provider credential",
  request: {
    params: providerIdParam,
    body: {
      content: {
        "application/json": { schema: putBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: credentialMetaSchema },
      },
      description:
        "Credential stored (encrypted at rest) — meta only, tokens are never returned",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{providerId}",
  tags: ["Admin — Provider Credentials"],
  summary: "Get a provider credential's meta",
  request: {
    params: providerIdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: credentialMetaSchema },
      },
      description: "Credential meta — decrypted tokens are NEVER returned",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "No credential stored for this provider",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Credential exists but cannot be decrypted — BETTER_AUTH_SECRET rotated; PUT a new credential or DELETE",
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{providerId}",
  tags: ["Admin — Provider Credentials"],
  summary: "Purge a provider's stored credentials (oauth + derived)",
  description:
    "Disconnect: hard-deletes EVERY stored credential for the provider — " +
    "the oauth grant AND the server-derived config (minted webhook secret + " +
    "grabbed phc_) — so no orphaned rows remain.",
  request: {
    params: providerIdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ deleted: z.boolean() }) },
      },
      description: "Credentials hard-deleted (at least one row removed)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "No credentials stored for this provider",
    },
  },
});

function serializeMeta(meta: ProviderCredentialMeta) {
  // This admin surface is OAuth-only: PUT forces `kind: "oauth"` and GET reads
  // the oauth credential, so the meta's kind is always "oauth" at runtime even
  // though `ProviderCredentialMeta.kind` widened to the "oauth" | "derived"
  // union when the derived store landed. Narrow it back to the schema literal.
  return {
    providerId: meta.providerId,
    kind: "oauth" as const,
    scopes: meta.scopes,
    expiresAt: meta.expiresAt.toISOString(),
    scopedTeams: meta.scopedTeams,
    createdAt: meta.createdAt.toISOString(),
    updatedAt: meta.updatedAt.toISOString(),
  };
}

export const providerCredentialsRouter = new OpenAPIHono<AppEnv>()
  .openapi(upsertRoute, async (c) => {
    const { db } = c.get("container");
    const { providerId } = c.req.valid("param");
    const body = c.req.valid("json");

    // PUT is a full idempotent upsert — create and update are the same 200.
    const meta = await saveProviderCredential(db, {
      providerId,
      kind: body.kind,
      payload: body.payload,
    });

    return c.json(serializeMeta(meta), 200);
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { providerId } = c.req.valid("param");

    try {
      const record = await getProviderCredential(db, providerId);
      if (!record) {
        return c.json({ error: "Provider credential not found" }, 404);
      }
      return c.json(serializeMeta(toCredentialMeta(record)), 200);
    } catch (error) {
      if (error instanceof ProviderCredentialDecryptError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  })
  .openapi(deleteRoute, async (c) => {
    const { db } = c.get("container");
    const { providerId } = c.req.valid("param");

    // Never decrypts — DELETE must succeed even when the payload is
    // undecryptable (the operator's escape hatch after a secret rotation).
    // Disconnect purges BOTH kinds (oauth grant + derived config) so the
    // minted webhook secret + grabbed phc_ never linger orphaned.
    const { oauth, derived } = await deleteAllProviderCredentials(
      db,
      providerId,
    );
    if (!oauth && !derived) {
      return c.json({ error: "Provider credential not found" }, 404);
    }
    return c.json({ deleted: true }, 200);
  });
