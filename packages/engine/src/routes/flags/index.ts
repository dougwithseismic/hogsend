import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { evaluateFlagsForContact } from "../../lib/flags.js";
import { errorSchema } from "../../lib/schemas.js";
import { resolveFeedRecipient } from "../feed/recipient.js";

// The evaluated flag map — values are arbitrary JSON (boolean flags → true, the
// default; multivariate → the arm's `value`).
const flagsMapSchema = z.object({
  flags: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// GET /v1/flags — the BROWSER read (publishable OR secret-ingest tier).
// Identity is recipient-scoped SERVER-SIDE via `resolveFeedRecipient` (the same
// leak boundary as the in-app feed): a userToken-verified userId, a secret
// key's trusted userId/email, or a publishable caller's OWN anon id — a pk_
// `anonymousId` that collides with an IDENTIFIED contact's canonical key is
// rejected (403), so a browser key can never read another user's flags.
// ---------------------------------------------------------------------------
const listQuerySchema = z.object({
  userToken: z.string().optional(),
  anonymousId: z.string().optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Flags"],
  summary: "Evaluate all flags for the resolved recipient",
  description:
    "Recipient-scoped server-side. A publishable key reads its own anon flags (anonymousId) or a token-verified userId; a secret key may pass userId/email directly. NEVER reads the contact key from the request.",
  request: { query: listQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: flagsMapSchema } },
      description: "The recipient's evaluated flag map",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid userToken or non-addressable anonymousId",
    },
  },
});

// ---------------------------------------------------------------------------
// POST /v1/flags/evaluate — the SERVER SDK read (secret-key only; guarded by
// `requireApiKey` + `requireScope("ingest")` in routes/index.ts). The canonical
// contact key is resolved SERVER-TRUSTED from userId/email via the same
// `resolveFeedRecipient` (a secret caller is never `publishable`, so its
// userId/email is trusted directly).
// ---------------------------------------------------------------------------
const evaluateBodySchema = z.object({
  userId: z.string().optional(),
  email: z.string().optional(),
});

const evaluateRoute = createRoute({
  method: "post",
  path: "/evaluate",
  tags: ["Flags"],
  summary: "Evaluate all flags for a contact (server SDK)",
  description:
    "Secret-key only. Resolves the canonical contact key server-trusted from userId/email and returns the evaluated flag map.",
  request: {
    body: {
      content: { "application/json": { schema: evaluateBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: flagsMapSchema } },
      description: "The contact's evaluated flag map",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing identity",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid userToken",
    },
  },
});

export const flagsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const rec = await resolveFeedRecipient(c, c.req.valid("query"));
    if (!rec.ok) return c.json({ error: rec.error }, rec.status);
    const flags = await evaluateFlagsForContact({
      db,
      contactKey: rec.recipientKey,
      contactId: rec.contactId,
      // BROWSER path: server-only scan leaves (event/email_engagement)
      // short-circuit to false — NO per-flag DB query (the O(1) invariant).
      mode: "browser",
    });
    return c.json({ flags }, 200);
  })
  .openapi(evaluateRoute, async (c) => {
    const { db } = c.get("container");
    const rec = await resolveFeedRecipient(c, c.req.valid("json"));
    if (!rec.ok) return c.json({ error: rec.error }, rec.status);
    const flags = await evaluateFlagsForContact({
      db,
      contactKey: rec.recipientKey,
      contactId: rec.contactId,
      // SERVER path (secret-key only): event/email_engagement leaves resolve
      // server-side via evaluateCondition.
      mode: "server",
    });
    return c.json({ flags }, 200);
  });
