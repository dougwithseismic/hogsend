import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import type { HogsendClient } from "../container.js";
import { ingestEvent } from "../lib/ingestion.js";
import { type ColdConnectBranding, coldConnectPageHtml } from "./page.js";
import {
  type ColdConnectThrottleConfig,
  checkColdConnectThrottle,
} from "./throttle.js";
import {
  buildColdConnectUrl,
  type ColdConnectBinding,
  consumeColdConnectToken,
  mintColdConnectToken,
  peekColdConnectToken,
} from "./token.js";

export type { ColdConnectBranding } from "./page.js";
export type { ColdConnectThrottleConfig } from "./throttle.js";
export type { ColdConnectBinding } from "./token.js";

/**
 * The identity column an `identityKind` resolves a contact on. `userId` and
 * `anonymousId` ride the `external_id`/`anonymous_id` columns under a
 * caller-chosen `platformKey` prefix (e.g. `telegram:`) — there is NO engine-side
 * collision guard there (unlike `discordId`'s dedicated column), so the
 * `platformKey` prefix IS the namespace. `discordId` resolves the dedicated
 * Discord column.
 */
export type ColdConnectIdentityKind = "userId" | "discordId" | "anonymousId";

/** Config for {@link createColdConnect}. */
export interface ColdConnectConfig<S = Record<string, unknown>> {
  /** Stable connector id — seals the token, names the basePath, scopes throttle. */
  connectorId: string;
  /** Which `ingestEvent` identity column the platform key resolves on. */
  identityKind: ColdConnectIdentityKind;
  /** Map a raw platform user id to the namespaced ingest key (e.g. `telegram:<id>`). */
  platformKey: (platformUserId: string) => string;
  /** Event name pushed by the exchange's ingest — what the welcome journey `onEvents` on. */
  linkedEvent: string;
  /** The person-property key the connect page sets in `posthog.identify`. */
  identifyPropKey: string;
  /**
   * Build the ingest payload from the sealed binding. CORRECTION (locked): any
   * property the linked/welcome journey BRANCHES on (`user.properties.<id>`)
   * MUST be a scalar `eventProperties` entry — `contactProperties` never reach
   * the Hatchet payload.
   */
  buildIngest: (binding: ColdConnectBinding<S>) => {
    eventProperties: Record<string, unknown>;
    contactProperties?: Record<string, unknown>;
  };
  /** Connect-page branding (plain-text fields; accentColor regex-validated). */
  branding: ColdConnectBranding;
  /** Confirm-token TTL (seconds). Default 900. */
  ttlSeconds?: number;
  /** Mint-throttle config (Redis-INCR, fail-closed). */
  throttle?: ColdConnectThrottleConfig;
  /**
   * Optional consumer hook run AFTER the bind commits, BEFORE the token is
   * consumed (e.g. Discord `grantVerifiedRole`). AT-LEAST-ONCE: must be
   * idempotent. The token is consumed even if this throws — the bind already
   * committed, so a flaky hook must not keep the token live and re-fire on every
   * click.
   */
  afterBind?: (
    binding: ColdConnectBinding<S> & { contactKey: string },
    deps: { container: HogsendClient },
  ) => Promise<void>;
}

export type MintConfirmResult =
  | { ok: true; token: string }
  | { ok: false; reason: string };

/** The object returned by {@link createColdConnect}. */
export interface ColdConnect<S = Record<string, unknown>> {
  /**
   * Mint a confirm token (throttled, fail-closed). Returns `{ ok:false }` when
   * throttled or Redis is unavailable — the caller MUST NOT send a link then.
   */
  mintConfirm(args: {
    platformUserId: string;
    email: string;
    scalars?: S;
  }): Promise<MintConfirmResult>;
  /** Build the connect URL for a minted token on the given API_PUBLIC_URL. */
  confirmUrl(args: { apiPublicUrl: string; token: string }): string;
  /** Mount `GET /connect/<id>` + `POST /connect/<id>/exchange` on the app. */
  routes(app: OpenAPIHono<AppEnv>): void;
}

/**
 * Build a cold-connect flow: chat `/link <email>` → emailed one-click confirm
 * link → click → engine-served connect page → button POST → server-sealed token
 * → `ingestEvent` folds the two contact rows into one + returns the canonical
 * `contactKey` → page runs CLIENT-side `posthog.identify(contactKey)`.
 *
 * Returns `{ mintConfirm, confirmUrl, routes }`. `routes` derives its basePath
 * from `config.connectorId` (never a caller-chosen mount) and the exchange
 * asserts the sealed `binding.connectorId === connectorId` (410 on mismatch),
 * for cross-connector token isolation.
 */
export function createColdConnect<S = Record<string, unknown>>(
  config: ColdConnectConfig<S>,
): ColdConnect<S> {
  const { connectorId } = config;
  const pagePath = `/connect/${connectorId}`;
  const exchangePath = `/connect/${connectorId}/exchange`;

  return {
    async mintConfirm(args) {
      const throttle = await checkColdConnectThrottle({
        connectorId,
        platformUserId: args.platformUserId,
        email: args.email,
        config: config.throttle,
      });
      if (!throttle.ok) {
        return { ok: false, reason: throttle.reason };
      }

      const token = await mintColdConnectToken<S>({
        binding: {
          connectorId,
          platformUserId: args.platformUserId,
          email: args.email,
          scalars: args.scalars,
        },
        ttlSeconds: config.ttlSeconds,
      });
      if (!token) return { ok: false, reason: "redis_unavailable" };
      return { ok: true, token };
    },

    confirmUrl(args) {
      return buildColdConnectUrl({
        apiPublicUrl: args.apiPublicUrl,
        connectorId,
        token: args.token,
      });
    },

    routes(app) {
      // GET = pure page render (no writes). `?tok=` is read CLIENT-side, never
      // reflected into the markup.
      app.get(pagePath, (c) => {
        const { env } = c.get("container");
        return c.html(
          coldConnectPageHtml(config.branding, {
            posthogKey: env.POSTHOG_API_KEY ?? null,
            posthogHost: env.POSTHOG_HOST ?? null,
            exchangeUrl: exchangePath,
            identifyPropKey: config.identifyPropKey,
          }),
        );
      });

      // POST = the bind. Body is `{tok}` ONLY (identity fields are rejected —
      // they only ever come from the sealed token).
      app.post(exchangePath, async (c) => {
        const container = c.get("container");

        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: "bad_json" }, 400);
        }
        const tok =
          body && typeof (body as { tok?: unknown }).tok === "string"
            ? (body as { tok: string }).tok
            : "";
        if (!tok) {
          return c.json({ ok: false, error: "missing_token" }, 400);
        }

        const binding = await peekColdConnectToken<S>({
          connectorId,
          token: tok,
        });
        if (!binding) {
          return c.json({ ok: false, error: "invalid_or_used" }, 410);
        }

        // Cross-connector token isolation: a token minted for another connector
        // can never be redeemed here even if a composer miswired the mounts.
        if (binding.connectorId !== connectorId) {
          return c.json({ ok: false, error: "connector_mismatch" }, 410);
        }

        const platformKey = config.platformKey(binding.platformUserId);
        const { eventProperties, contactProperties } =
          config.buildIngest(binding);

        // Authoritative bind via ingestEvent (NOT linkContact — linkContact never
        // calls hatchet.events.push, which would kill the welcome journey that
        // `onEvents:[linkedEvent]`). ingestEvent returns the canonical contactKey
        // (handed to the page's posthog.identify) and fires the analytics merge.
        // If this throws (Hatchet/DB blip → 500), the token is NOT consumed
        // below, so the user's retry still works (peek, not consume-on-read).
        const result = await ingestEvent({
          db: container.db,
          registry: container.registry,
          hatchet: container.hatchet,
          logger: container.logger,
          analytics: container.analytics,
          event: {
            event: config.linkedEvent,
            [config.identityKind]: platformKey,
            userEmail: binding.email,
            eventProperties,
            contactProperties,
            source: "connector",
            idempotencyKey: `cc:confirm:${connectorId}:${binding.platformUserId}:${tok}`,
          },
        });

        const contactKey = result.contactKey;

        // afterBind is AT-LEAST-ONCE (idempotent-required). The token is consumed
        // even if it throws — the bind already committed, so a flaky hook must not
        // keep the token live and re-fire on every click.
        try {
          await config.afterBind?.({ ...binding, contactKey }, { container });
        } catch (err) {
          container.logger.warn("coldConnect afterBind threw", {
            connectorId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await consumeColdConnectToken({ connectorId, token: tok });
        }

        return c.json({
          ok: true,
          key: contactKey,
          platformUserId: binding.platformUserId,
        });
      });
    },
  };
}
