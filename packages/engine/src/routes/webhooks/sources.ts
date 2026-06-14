import type { Database } from "@hogsend/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import type { DefinedConnector } from "../../connectors/define-connector.js";
import { headersToRecord } from "../../lib/headers.js";
import { ingestEvent } from "../../lib/ingestion.js";
import type { Logger } from "../../lib/logger.js";
import { getDerivedCredential } from "../../lib/provider-credentials.js";
import { verifySignature } from "../../webhook-sources/verify.js";

/** Negative-cache window for the stored PostHog secret (mirrors the token
 * manager's ABSENT_RECHECK_MS) — caches present AND absent results so an
 * inbound PostHog webhook POST does not hit the DB on every request. */
const STORED_SECRET_RECHECK_MS = 30_000;

let storedPosthogSecret: { value: string | undefined; at: number } | undefined;

/**
 * The minted PostHog webhook secret falls back to the `kind="derived"` store
 * when `POSTHOG_WEBHOOK_SECRET` is unset — so an inbound event verifies WITHOUT
 * a redeploy after `hogsend connect posthog`. Cached (present and absent) for
 * `STORED_SECRET_RECHECK_MS` to keep the hot webhook path off the DB.
 *
 * A store read failure (e.g. DB blip, or a derived row that no longer decrypts)
 * resolves to `undefined` rather than throwing — the inbound webhook path must
 * not 500 on a degraded store. `undefined` keeps match-auth in its pre-feature
 * posture (OPEN when no secret is configured anywhere), and the failure is
 * logged so the misconfiguration is still visible.
 */
async function resolveStoredPosthogSecret(
  db: Database,
  logger: Logger,
): Promise<string | undefined> {
  const now = Date.now();
  if (
    storedPosthogSecret &&
    now - storedPosthogSecret.at <= STORED_SECRET_RECHECK_MS
  ) {
    return storedPosthogSecret.value;
  }

  let value: string | undefined;
  try {
    value = (await getDerivedCredential(db, "posthog"))?.webhookSecret;
  } catch (err) {
    logger.warn("Failed to resolve stored PostHog webhook secret", {
      error: err instanceof Error ? err.message : String(err),
    });
    value = undefined;
  }
  storedPosthogSecret = { value, at: now };
  return value;
}

/**
 * Drop the module-level stored-secret cache so the next inbound PostHog webhook
 * re-reads from the `kind="derived"` store. Called right after `hogsend connect`
 * mints + persists a secret, so the freshly-minted value is enforced
 * immediately instead of waiting out the `STORED_SECRET_RECHECK_MS` window.
 */
export function invalidateStoredPosthogSecret(): void {
  storedPosthogSecret = undefined;
}

export function registerWebhookSourceRoutes(
  app: OpenAPIHono<AppEnv>,
  sources: DefinedConnector[], // already filtered to transport === "webhook"
) {
  // Reserve `email` for the email-provider route
  // (`POST /v1/webhooks/email/:providerId`). A source with `meta.id === "email"`
  // would shadow that prefix, so fail loudly at registration rather than let it
  // silently break provider webhooks.
  for (const source of sources) {
    if (source.meta.id === "email") {
      throw new Error(
        'Webhook source id "email" is reserved for the email-provider route ' +
          "(POST /v1/webhooks/email/:providerId). Rename the source.",
      );
    }
  }

  const sourceMap = new Map(sources.map((s) => [s.meta.id, s]));

  const webhookRoute = createRoute({
    method: "post",
    path: "/v1/webhooks/{sourceId}",
    request: {
      params: z.object({ sourceId: z.string() }),
    },
    responses: {
      200: {
        description: "Webhook accepted",
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              skipped: z.boolean().optional(),
              event: z.string().optional(),
              userId: z.string().optional(),
              exits: z.number().optional(),
            }),
          },
        },
      },
      400: {
        description: "Invalid payload",
      },
      401: {
        description: "Unauthorized",
      },
      404: {
        description: "Source not found",
      },
    },
  });

  app.openapi(webhookRoute, async (c) => {
    const { sourceId } = c.req.valid("param");
    const source = sourceMap.get(sourceId);

    if (!source) {
      return c.json({ error: "Unknown webhook source" }, 404);
    }

    // Webhook-transport connectors always carry inboundVerify (defineConnector
    // enforces it at authoring time). Narrow once so the rest of the auth ladder
    // is byte-identical to the pre-connector source dispatch.
    const auth = source.inboundVerify;
    if (!auth) return c.json({ error: "Unknown webhook source" }, 404);

    const { db, logger, env, registry, hatchet } = c.get("container");

    // Read the body ONCE as the EXACT received bytes — signature schemes verify
    // over these bytes, so we must not re-stringify. JSON.parse only AFTER auth.
    const rawBody = await c.req.text();
    const headers = headersToRecord(c.req.raw.headers);

    let secret = env[auth.envKey as keyof typeof env] as string | undefined;

    // For the inbound PostHog source, fall back to the secret minted by
    // `hogsend connect` (kind="derived" store) when env has none — so an
    // inbound event verifies WITHOUT a redeploy. Leaves match-auth OPEN when
    // neither env nor the store has a secret (current behavior preserved).
    if (
      !secret &&
      auth.type === "match" &&
      auth.envKey === "POSTHOG_WEBHOOK_SECRET"
    ) {
      secret = await resolveStoredPosthogSecret(db, logger);
    }

    if (auth.type === "signature") {
      // Signature sources FAIL CLOSED: an unset secret is a 401, never an open
      // pass-through (deliberate divergence from the "match" variant).
      if (!secret) {
        logger.warn("Webhook signature secret not configured", {
          source: sourceId,
        });
        return c.json({ error: "Webhook signature not configured" }, 401);
      }

      let verified = false;

      if (auth.verify) {
        verified = await auth.verify({ rawBody, headers, secret });
      } else {
        verified = verifySignature(
          auth.scheme,
          { rawBody, headers, secret },
          auth.header,
        );
      }

      // Optional plain shared-secret fallback (e.g. Supabase's
      // `x-supabase-webhook-secret`) when the signature headers are absent.
      if (!verified && auth.fallbackMatchHeader) {
        const provided = headers[auth.fallbackMatchHeader.toLowerCase()];
        verified = provided === secret;
      }

      if (!verified) {
        return c.json({ error: "Invalid webhook signature" }, 401);
      }
    } else {
      // "match": shared-secret equality. An unconfigured source stays OPEN
      // (parity with the pre-engine route).
      if (secret) {
        const provided =
          headers[auth.header.toLowerCase()] ??
          headers.authorization?.replace("Bearer ", "");

        if (provided !== secret) {
          return c.json({ error: "Invalid webhook secret" }, 401);
        }
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json(
        { error: "Invalid payload", details: "Malformed JSON" },
        400,
      );
    }

    if (source.schema) {
      const parsed = source.schema.safeParse(payload);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid payload", details: parsed.error.flatten() },
          400,
        );
      }
      payload = parsed.data;
    }

    const event = await source.transform(payload, {
      db,
      logger,
      transport: "webhook",
      rawBody,
      headers,
    });
    if (!event) {
      logger.info("Webhook event skipped", { source: sourceId });
      return c.json({ ok: true, skipped: true });
    }

    const result = await ingestEvent({ db, registry, hatchet, logger, event });

    return c.json({
      ok: true,
      event: event.event,
      userId: event.userId,
      // INTENTIONALLY the ExitResult[] ARRAY (not `.length`) — preserved
      // byte-for-byte for back-compat. The OpenAPI schema declares
      // `exits: z.number().optional()`, but this route has always returned the
      // array; the NEW `/v1/connectors/:id/ingress` route returns
      // `result.exits.length` as a deliberate divergence. Do NOT "tidy" either
      // to match the other.
      exits: result.exits,
    });
  });
}
