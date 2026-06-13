import type { Database } from "@hogsend/db";
import type { z } from "zod";
import type { env as engineEnv } from "../env.js";
import type { ConnectorStateIntent } from "../lib/connector-state.js";
import type { IngestEvent } from "../lib/ingestion.js";
import type { Logger } from "../lib/logger.js";
import type {
  SignatureScheme,
  VerifySignatureArgs,
} from "../webhook-sources/verify.js";

/**
 * The unified INBOUND connector abstraction. A connector is one platform's
 * inbound face — it turns a raw platform payload into an {@link IngestEvent}
 * via {@link DefinedConnector.transform}. The transform contract is IDENTICAL
 * across transports; only the ACTIVATION RUNTIME differs:
 *
 *  - `"webhook"` — an HTTP route (`POST /v1/webhooks/:id`) verifies the inbound
 *    request and calls `transform`. (The long-standing `defineWebhookSource`
 *    behavior, now one transport under this umbrella.)
 *  - `"gateway"` — a long-lived worker process (its OWN entrypoint / Railway
 *    service, NOT a Hatchet task) holds a socket to the platform, and on each
 *    platform event POSTs into this connector's own ingress
 *    (`POST /v1/connectors/:id/ingress`, shared internal secret) so ALL
 *    transform logic stays here and the socket worker stays dumb.
 *  - `"poll"` — a Hatchet cron pulls the platform on a schedule (using the
 *    stored credential) and runs `transform` per pulled item.
 *
 * The symmetric INBOUND twin of {@link DefinedDestination}.
 * {@link defineConnector} is an identity / validating function.
 */
export type ConnectorTransport = "webhook" | "gateway" | "poll";

// ---------------------------------------------------------------------------
// Auth is TRANSPORT-SHAPED — two distinct concerns, never one union.
// ---------------------------------------------------------------------------

/**
 * INBOUND-REQUEST VERIFICATION — webhook transport only. "Does this HTTP
 * request prove it came from the platform?" The EXACT pre-existing
 * `WebhookSourceAuth` union, re-homed here (re-exported by
 * define-webhook-source for back-compat). `match` = shared-secret equality
 * (OPEN when unset); `signature` = provider HMAC (FAIL CLOSED when unset).
 */
export type InboundVerifyAuth =
  | {
      type: "match";
      header: string;
      envKey: string;
    }
  | {
      type: "signature";
      scheme: SignatureScheme;
      envKey: string;
      header: string;
      fallbackMatchHeader?: string;
      verify?(args: VerifySignatureArgs): boolean | Promise<boolean>;
    };

/**
 * STORED OUTBOUND CREDENTIAL — gateway/poll transports only. The connector PULLS
 * from the platform and must present a credential. Declares WHICH
 * `provider_credentials` row to read. The engine resolves the row at activation
 * time and hands the decrypted material to the gateway worker / poll cron —
 * never the transform. SEPARATE from {@link InboundVerifyAuth} by design.
 */
export interface StoredCredentialRef {
  /** `provider_credentials.providerId` to read (defaults to `meta.id`). */
  providerId?: string;
  /** Which credential kind the runtime resolves. Default `"oauth"`. */
  kind?: "oauth" | "derived";
}

// ---------------------------------------------------------------------------
// Context handed to transform()
// ---------------------------------------------------------------------------

/**
 * Side context handed to {@link DefinedConnector.transform}. A superset of the
 * old `WebhookSourceCtx`: `rawBody`/`headers` are populated by the webhook
 * route; `transport` lets a shared transform branch when a platform feeds more
 * than one transport.
 */
export interface ConnectorCtx {
  db: Database;
  logger: Logger;
  /** Which activation runtime invoked the transform. */
  transport: ConnectorTransport;
  /** Webhook transport only — EXACT raw request bytes. */
  rawBody?: string;
  /** Webhook transport only — inbound request headers (lowercased keys). */
  headers?: Record<string, string>;
}

export interface ConnectorMeta {
  id: string;
  name: string;
  description?: string;
  /** The activation runtime. Defaults to `"webhook"` (back-compat). */
  transport?: ConnectorTransport;
}

// ---------------------------------------------------------------------------
// OAuth / interactions handlers — the GENERIC engine route surface.
// ---------------------------------------------------------------------------

/**
 * Minimal handler context for the generic connector routes. `env` is the EXACT
 * validated engine env object (number/boolean fields included) — NOT a string
 * Record — so the route can pass `c.get("container").env` straight through.
 */
export interface ConnectorRouteCtx {
  db: Database;
  logger: Logger;
  env: typeof engineEnv;
  /** Public base URL of this instance (redirect-URI construction). */
  apiPublicUrl: string;
}

export type ConnectorOAuthResult =
  | { kind: "redirect"; location: string }
  | { kind: "json"; status: number; body: unknown };

export type ConnectorInteractionResult =
  // A non-event handshake the connector already answered (route 200s `body`).
  | { kind: "ack"; status?: number; body?: unknown }
  // An event to push through the ingest pipeline (route ingests + 200s).
  | { kind: "ingest"; event: IngestEvent }
  // Signature failed — route 401s.
  | { kind: "unauthorized" };

/**
 * OPTIONAL per-connector OAuth + interactions hooks dispatched by the GENERIC
 * engine routes (mirrors how `/v1/webhooks/:sourceId` dispatches `transform`),
 * so platform #3 needs no new routes.
 *
 *  - `oauthCallback` — handle `GET|POST /v1/connectors/:id/oauth/callback`:
 *    exchange the code, persist into `provider_credentials`, return a
 *    redirect/JSON result. The connector imports the engine's credential-save
 *    helpers directly (they are public exports). The ENGINE owns CSRF `state`
 *    verification GENERICALLY (the route verifies the signed state before
 *    dispatch and hands the decoded {@link ConnectorStateIntent} in as `state`);
 *    the handler must NOT re-verify the raw query `state`.
 *  - `interactions` — handle `POST /v1/connectors/:id/interactions`: the
 *    connector verifies the platform signature ITSELF (Discord ed25519), may
 *    200 a handshake (Discord PING), and may return an {@link IngestEvent}.
 */
export interface ConnectorHandlers {
  oauthCallback?(args: {
    query: Record<string, string>;
    body: unknown;
    /** Engine-verified, decoded OAuth `state` (CSRF + member-link binding). */
    state: ConnectorStateIntent;
    ctx: ConnectorRouteCtx;
  }): Promise<ConnectorOAuthResult>;
  interactions?(args: {
    rawBody: string;
    headers: Record<string, string>;
    ctx: ConnectorRouteCtx;
  }): Promise<ConnectorInteractionResult>;
}

// ---------------------------------------------------------------------------
// The umbrella interface
// ---------------------------------------------------------------------------

export interface DefinedConnector<T = unknown> {
  meta: ConnectorMeta;
  /**
   * Inbound-request verification — REQUIRED for `transport: "webhook"`,
   * forbidden otherwise.
   */
  inboundVerify?: InboundVerifyAuth;
  /** Stored outbound credential to pull with — used by `gateway`/`poll`. */
  credential?: StoredCredentialRef;
  /** Optional Zod schema validating the payload BEFORE transform. */
  schema?: z.ZodSchema<T>;
  /** The transport-invariant heart: raw platform payload → IngestEvent | null. */
  transform(payload: T, ctx: ConnectorCtx): Promise<IngestEvent | null>;
  /** OPTIONAL OAuth + interactions hooks for the generic dispatch routes. */
  handlers?: ConnectorHandlers;
}

export function defineConnector<T>(
  def: DefinedConnector<T>,
): DefinedConnector<T> {
  // Cheap authoring guard: the two auth concerns are transport-shaped, so a
  // mis-paired definition is a config error worth catching at module load.
  const transport = def.meta.transport ?? "webhook";
  if (transport === "webhook" && !def.inboundVerify) {
    throw new Error(
      `connector "${def.meta.id}" (transport=webhook) must declare inboundVerify`,
    );
  }
  if (transport !== "webhook" && def.inboundVerify) {
    throw new Error(
      `connector "${def.meta.id}" (transport=${transport}) must not declare ` +
        "inboundVerify — gateway/poll pull with a stored credential",
    );
  }
  return def;
}
