import { randomBytes } from "node:crypto";
import { Webhook } from "svix";

/**
 * Outbound webhook signing core.
 *
 * Hogsend emits a Svix-style HMAC-SHA256 signed event stream. The signing
 * scheme is the Standard Webhooks spec (the same one `svix` implements and that
 * `plugin-resend` consumes for inbound Resend webhooks):
 *
 *   signedContent = `${id}.${timestampSeconds}.${body}`
 *   signature     = base64( HMAC_SHA256( base64decode(secret without `whsec_`), signedContent ) )
 *   header value  = `v1,${signature}`
 *
 * Pure `node:crypto` equivalent (documented for the SDK / spec consumers and
 * subscriber-side verification without a `svix` dependency):
 *
 *   import { createHmac, timingSafeEqual } from "node:crypto";
 *   const key = Buffer.from(secret.slice(6), "base64"); // drop the `whsec_` prefix
 *   const sig = createHmac("sha256", key)
 *     .update(`${id}.${ts}.${body}`)
 *     .digest("base64");
 *   const header = `v1,${sig}`;
 *   // compare each space-delimited `v1,<sig>` candidate with timingSafeEqual.
 */

/**
 * The 35-event catalog — the SINGLE source of truth (schema, routes, client,
 * CLI all derive from this). The `webhook.test` sentinel is intentionally NOT a
 * member (it is delivered out-of-band regardless of an endpoint's `eventTypes`).
 *
 * `contact.subscribed` mirrors `contact.unsubscribed` for a genuine opt-IN
 * (resubscribe-all or a category/channel grant), emitted from the single
 * preference-write choke with `source` provenance — the consent audit signal
 * for the explicit-opt-in SMS channel (grants were previously silent).
 *
 * The `sms.*` family mirrors the email lifecycle for the SMS channel:
 * `sms.sent` (provider-accepted, first-party), `sms.delivered` / `sms.failed`
 * (provider status webhook — the single source, no first-party signal), and
 * `sms.clicked` (first-party, per-hit, from the `/s/:code` short-link
 * redirect — the SMS sibling of `email.clicked`).
 *
 * `link.clicked` is the NON-email click event: a click on a tracked link that
 * has no email send (Discord/referral/ad-hoc `createTrackedLink`). It is the
 * deliberate counterpart to `email.clicked` so a non-email click never fires a
 * malformed `email.clicked` (MF-missing #3).
 *
 * `link.arrived` is the landing-confirmed subset of `link.clicked`: the
 * visitor reported back from the destination (opt-in `hs_ref` +
 * POST /v1/t/arrive) with identity evidence.
 *
 * The `account.*` family reports a player's third-party platform account
 * (`defineAccountLink`: Steam, Twitch, …) being bound to or released from a
 * contact. `account.linked` and `account.unlinked` are the two STATE events —
 * each carries the FULL current state including `{ state, version }`, never a
 * delta, so a subscriber upserts on `(provider, providerUserId)` and applies
 * only when `incoming.version > stored.version`. `account.link_failed` reports
 * a flow that ended without mutating anything, so it carries no version and
 * never mints a contact. Like `group.*`, all three are emitted from the
 * intent-layer link/unlink call sites ONLY — never from the ingest path.
 *
 * `impact.digest` is the weekly facts-only impact rollup (shipped journey
 * versions/labels + holdout-lift threshold crossings). It is the one
 * SELF-REFERENTIAL event: the digest cron derives its watermark from its
 * own `impact.digest` delivery rows in `webhook_deliveries`.
 */
export const WEBHOOK_EVENT_TYPES = [
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.unsubscribed",
  "contact.subscribed",
  // Global control group membership (impact plan §4.3) — emitted once per
  // contact key on the first withheld send.
  "contact.control_group",
  // A refinement landed vendor traits on a contact (`refineContact`). Emitted
  // ONLY on a genuine `status: "refined"` — never on `cached`, `not_found` or
  // `skipped`. A cache hit spends nothing and is not an event.
  "contact.refined",
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.action",
  "email.bounced",
  "email.complained",
  // A human REPLIED to a message a journey sent (PRD 16). The only email event
  // here that reports a message coming BACK rather than the fate of one going
  // out, and the only one whose payload can be uncorrelated: a reply whose
  // `In-Reply-To` names no send this instance made is still delivered, with
  // `correlated: false` and null send context, because dropping a human's words
  // to keep a payload tidy is the worse failure.
  "email.replied",
  "sms.sent",
  "sms.delivered",
  "sms.failed",
  "sms.clicked",
  "journey.completed",
  "journey.heldout",
  "bucket.entered",
  "bucket.left",
  "link.clicked",
  "link.arrived",
  "funnel.stage_changed",
  "deal.quoted",
  "deal.sold",
  // Group dimension (account/team/company-level). Emitted from the intent-layer
  // `/v1/groups` routes ONLY (never the ingest/associateGroups path):
  // `group.identified` on a successful identify, `group.member_added` /
  // `group.member_removed` on membership mutations.
  "group.identified",
  "group.member_added",
  "group.member_removed",
  // Third-party platform account links (`defineAccountLink`). Emitted from the
  // intent layer ONLY (the link/unlink call sites), never the ingest path.
  // The two STATE events carry full current state + a monotonic `version`;
  // `account.link_failed` mutated nothing, so it carries neither.
  "account.linked",
  "account.unlinked",
  "account.link_failed",
  // Weekly impact digest (impact experiments D5). Self-referential: the
  // cron watermarks off its own delivery rows.
  "impact.digest",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * Generate a new `whsec_<base64(32 bytes)>` signing secret plus its display
 * prefix (safe to surface on list/get responses).
 *
 * NOTE: the secret body is STANDARD base64, not base64url. svix (via
 * standardwebhooks → @stablelib/base64) strips the `whsec_` prefix and decodes
 * the remainder with a STRICT standard-base64 decoder that rejects the `-`/`_`
 * characters base64url emits (~74% of base64url secrets contain one and fail
 * `new Webhook(secret)`). Standard base64 round-trips cleanly through both svix
 * and the `node:crypto` fallback (`Buffer.from(secret.slice(6), "base64")`).
 */
export function generateWebhookSecret(): {
  secret: string;
  secretPrefix: string;
} {
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  return { secret, secretPrefix: secret.slice(0, 12) };
}

export interface SignedWebhook {
  headers: {
    "Webhook-Id": string;
    "Webhook-Timestamp": string;
    "Webhook-Signature": string;
    "Content-Type": "application/json";
  };
  /**
   * The EXACT bytes that were signed AND must be sent. Never re-stringify the
   * payload between signing and sending — the signature covers these bytes.
   */
  body: string;
}

/**
 * Sign an outbound webhook payload, producing the Standard Webhooks header set
 * (`Webhook-Id` / `Webhook-Timestamp` / `Webhook-Signature`) plus the exact
 * `body` bytes that were signed.
 *
 * `timestamp` is unix SECONDS — the caller passes `Math.floor(Date.now()/1000)`.
 * `payload` is JSON-stringified when an object; a string is used verbatim.
 */
export function signWebhook(opts: {
  id: string;
  timestamp: number;
  payload: unknown;
  secret: string;
}): SignedWebhook {
  const body =
    typeof opts.payload === "string"
      ? opts.payload
      : JSON.stringify(opts.payload);

  const wh = new Webhook(opts.secret);
  // svix's `sign` takes the timestamp as a Date and floors it to seconds
  // internally; pass the canonical seconds back through a Date to keep the exact
  // value the caller intended.
  const signature = wh.sign(opts.id, new Date(opts.timestamp * 1000), body);

  return {
    headers: {
      "Webhook-Id": opts.id,
      "Webhook-Timestamp": String(opts.timestamp),
      "Webhook-Signature": signature,
      "Content-Type": "application/json",
    },
    body,
  };
}

/**
 * Consumer/test-facing verification of an inbound Hogsend webhook. Enforces the
 * 5-minute timestamp tolerance and uses a constant-time signature compare (both
 * inside svix). Throws on a bad signature or stale timestamp.
 *
 * Accepts either Title-Case (`Webhook-Id`) or lowercase (`webhook-id`) header
 * keys — and the `svix-*` aliases — by normalizing the header map first.
 */
export function verifyWebhookSignature(opts: {
  payload: string;
  headers: Record<string, string>;
  secret: string;
}): unknown {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.headers)) {
    lowered[key.toLowerCase()] = value;
  }

  // Coalesce to "" so a genuinely-absent header reaches svix as an empty
  // string — svix then throws its own clear "Missing required header" rather
  // than a type error here.
  const id = lowered["webhook-id"] ?? lowered["svix-id"] ?? "";
  const timestamp =
    lowered["webhook-timestamp"] ?? lowered["svix-timestamp"] ?? "";
  const signature =
    lowered["webhook-signature"] ?? lowered["svix-signature"] ?? "";

  const wh = new Webhook(opts.secret);
  return wh.verify(opts.payload, {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  });
}
