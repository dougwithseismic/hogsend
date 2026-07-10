import { apiKeys } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { generateApiKey } from "../../lib/api-key-hash.js";
import { errorSchema } from "../../lib/schemas.js";

const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  // Per-key browser Origin allowlist for publishable (pk_) keys; null for
  // secret keys.
  allowedOrigins: z.array(z.string()).nullable(),
  createdBy: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — API Keys"],
  summary: "List API keys",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      includeRevoked: z.enum(["true", "false"]).default("false"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            keys: z.array(apiKeySchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated API key list",
    },
  },
});

const selfRoute = createRoute({
  method: "get",
  path: "/self",
  tags: ["Admin — API Keys"],
  summary: "Identify the authenticated credential (key id/name/scopes)",
  description:
    "Lets an agent (e.g. the MCP server) identify which key it connected with, " +
    "for audit-friendly startup logging and scope-aware behavior. Session " +
    "(cookie) auth returns actor: session with no key fields.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            actor: z.enum(["api-key", "session"]),
            id: z.string().nullable(),
            name: z.string().nullable(),
            scopes: z.array(z.string()),
          }),
        },
      },
      description: "The authenticated credential's identity",
    },
  },
});

const createKeyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — API Keys"],
  summary: "Create a new API key",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().min(1).max(100),
              scopes: z
                .array(
                  z.enum([
                    "read",
                    "journey-admin",
                    "full-admin",
                    "ingest",
                    "ingest-public",
                  ]),
                )
                .min(1)
                .default(["read"]),
              expiresAt: z.string().datetime().optional(),
              // Mint a PUBLISHABLE (pk_) browser key: forces scope
              // `["ingest-public"]` and requires a non-empty `allowedOrigins`.
              publishable: z.boolean().optional().default(false),
              allowedOrigins: z.array(z.string().url()).optional(),
            })
            .refine(
              (b) => !b.publishable || (b.allowedOrigins?.length ?? 0) > 0,
              {
                message:
                  "publishable keys require at least one allowedOrigins entry",
                path: ["allowedOrigins"],
              },
            ),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            name: z.string(),
            key: z.string(),
            keyPrefix: z.string(),
            scopes: z.array(z.string()),
            allowedOrigins: z.array(z.string()).nullable(),
            expiresAt: z.string().nullable(),
            createdAt: z.string(),
          }),
        },
      },
      description: "API key created — key is shown only once",
    },
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — API Keys"],
  summary: "Revoke an API key",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ revoked: z.boolean() }),
        },
      },
      description: "API key revoked",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "API key not found",
    },
  },
});

function serializeKey(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes as string[],
    allowedOrigins: row.allowedOrigins ?? null,
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const apiKeysRouter = new OpenAPIHono<AppEnv>()
  .openapi(selfRoute, async (c) => {
    const key = c.get("apiKey");
    if (!key) {
      return c.json(
        { actor: "session" as const, id: null, name: null, scopes: [] },
        200,
      );
    }
    return c.json(
      {
        actor: "api-key" as const,
        id: key.id === "legacy" ? null : key.id,
        name: key.name,
        scopes: key.scopes,
      },
      200,
    );
  })
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, includeRevoked } = c.req.valid("query");

    const where =
      includeRevoked === "true" ? undefined : isNull(apiKeys.revokedAt);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(apiKeys)
        .where(where)
        .orderBy(desc(apiKeys.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(apiKeys).where(where),
    ]);

    return c.json(
      {
        keys: rows.map(serializeKey),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(createKeyRoute, async (c) => {
    const { db } = c.get("container");
    const body = c.req.valid("json");
    const actor = c.get("apiKey");

    const { key, prefix, hash } = generateApiKey({
      publishable: body.publishable,
    });

    // A publishable (pk_) key is FORCED to exactly `["ingest-public"]` —
    // regardless of any submitted `scopes` — so it can never carry
    // `ingest`/`full-admin` (non-negotiable: no escalation). Secret keys keep
    // their submitted scopes and a null allowlist (path untouched).
    const scopes = body.publishable ? ["ingest-public"] : body.scopes;

    const [created] = await db
      .insert(apiKeys)
      .values({
        name: body.name,
        keyPrefix: prefix,
        keyHash: hash,
        scopes,
        allowedOrigins: body.publishable ? (body.allowedOrigins ?? null) : null,
        createdBy: actor?.name ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .returning();

    if (!created) throw new Error("Failed to create API key");

    return c.json(
      {
        id: created.id,
        name: created.name,
        key,
        keyPrefix: prefix,
        scopes: created.scopes as string[],
        allowedOrigins: created.allowedOrigins ?? null,
        expiresAt: created.expiresAt?.toISOString() ?? null,
        createdAt: created.createdAt.toISOString(),
      },
      201,
    );
  })
  .openapi(revokeRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (!rows[0]) {
      return c.json({ error: "API key not found or already revoked" }, 404);
    }

    await db
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(apiKeys.id, id));

    return c.json({ revoked: true }, 200);
  });
