import { createHmac, timingSafeEqual } from "node:crypto";
import { Webhook } from "svix";

/** Default tolerance (seconds) for the timestamp freshness check. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Lowercase every header key so callers can pass the Title-Case headers Hogsend
 * sends (`Webhook-Id`/`Webhook-Timestamp`/`Webhook-Signature`) OR the lowercase
 * form a framework may hand back. Svix expects lowercase `svix-*`/`webhook-*`.
 */
function normalizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Verify and parse an INBOUND Hogsend outbound-webhook delivery, the
 * subscriber-side counterpart of the engine's signing. Use this in a handler
 * that receives Hogsend's signed POSTs to confirm authenticity before trusting
 * the body.
 *
 * Pass the RAW request body bytes (the exact string Hogsend signed — never a
 * re-stringified object), the request headers, and the endpoint's `whsec_…`
 * signing secret (from create / rotate-secret). Returns the parsed event
 * envelope (`{ id, type, timestamp, data }`) on success.
 *
 * Throws on a bad signature, a missing signature header, or a timestamp outside
 * the 5-minute tolerance window.
 *
 * Implementation: wraps svix's `Webhook.verify` (constant-time, tolerance-
 * checked); if svix cannot run for any reason it falls back to a pure
 * `node:crypto` HMAC-SHA256 check over `${id}.${timestamp}.${body}` with a
 * `timingSafeEqual` compare against the `v1,<base64>` signature(s).
 *
 * @example
 * ```ts
 * import { verifyHogsendWebhook } from "@hogsend/client";
 *
 * app.post("/webhooks/hogsend", async (req, res) => {
 *   const body = await readRawBody(req); // the exact bytes
 *   try {
 *     const event = verifyHogsendWebhook({
 *       payload: body,
 *       headers: req.headers,
 *       secret: process.env.HOGSEND_WEBHOOK_SECRET!,
 *     });
 *     // handle event.type ...
 *     res.sendStatus(200);
 *   } catch {
 *     res.sendStatus(401);
 *   }
 * });
 * ```
 */
export function verifyHogsendWebhook(opts: {
  payload: string;
  headers: Record<string, string>;
  secret: string;
}): unknown {
  const headers = normalizeHeaders(opts.headers);
  const id = headers["webhook-id"] ?? headers["svix-id"];
  const timestamp = headers["webhook-timestamp"] ?? headers["svix-timestamp"];
  const signature = headers["webhook-signature"] ?? headers["svix-signature"];

  if (!id || !timestamp || !signature) {
    throw new Error(
      "verifyHogsendWebhook: missing Webhook-Id / Webhook-Timestamp / Webhook-Signature header",
    );
  }

  try {
    const wh = new Webhook(opts.secret);
    return wh.verify(opts.payload, {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    });
  } catch {
    // svix unavailable (tree-shaken) or threw — fall back to node:crypto. We
    // re-run the SAME canonical check so a genuine signature/timestamp failure
    // still throws; only a svix-internal/import failure is "rescued".
    return verifyWithNodeCrypto({
      payload: opts.payload,
      secret: opts.secret,
      id,
      timestamp,
      signature,
    });
  }
}

/**
 * Pure `node:crypto` verification of the Svix signature scheme. Mirrors the
 * documented fallback in the engine's webhook-signing lib:
 * `HMAC_SHA256(base64-decoded secret, `${id}.${ts}.${body}`)` → `v1,<base64>`,
 * `timingSafeEqual` against each space-separated signature in the header.
 */
function verifyWithNodeCrypto(opts: {
  payload: string;
  secret: string;
  id: string;
  timestamp: string;
  signature: string;
}): unknown {
  const ts = Number.parseInt(opts.timestamp, 10);
  if (!Number.isFinite(ts)) {
    throw new Error("verifyHogsendWebhook: invalid Webhook-Timestamp");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) {
    throw new Error("verifyHogsendWebhook: timestamp outside tolerance window");
  }

  // The secret is `whsec_<base64>`; the signing key is the base64-decoded body.
  const key = opts.secret.startsWith("whsec_")
    ? Buffer.from(opts.secret.slice(6), "base64")
    : Buffer.from(opts.secret, "base64");
  const signedContent = `${opts.id}.${opts.timestamp}.${opts.payload}`;
  const expected = createHmac("sha256", key)
    .update(signedContent)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  // The header is space-separated `v1,<sig>` pairs; accept if ANY matches.
  const matched = opts.signature.split(" ").some((part) => {
    const sig = part.startsWith("v1,") ? part.slice(3) : part;
    const candidate = Buffer.from(sig);
    return (
      candidate.length === expectedBuf.length &&
      timingSafeEqual(candidate, expectedBuf)
    );
  });

  if (!matched) {
    throw new Error("verifyHogsendWebhook: signature verification failed");
  }

  return JSON.parse(opts.payload);
}
