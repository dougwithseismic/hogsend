import { createHmac, timingSafeEqual } from "node:crypto";
import { Webhook } from "svix";

/**
 * The signature verification schemes understood by `defineWebhookSource`'s
 * `auth.type: "signature"` variant. Each preset (Clerk, Supabase, Stripe,
 * Segment) maps to one of these; the route resolves the secret from
 * `env[auth.envKey]` and calls {@link verifySignature} BEFORE parsing/handing
 * the payload to `transform()`.
 *
 *  - `"svix"`      — Standard Webhooks / Svix header set (`svix-id` /
 *                    `svix-timestamp` / `svix-signature`). Reuses
 *                    `svix`'s `Webhook.verify` (the same machinery `plugin-resend`
 *                    uses for inbound Resend webhooks).
 *  - `"stripe"`    — `stripe-signature: t=<ts>,v1=<hex>[,v1=<hex>...]`. Computes
 *                    `HMAC_SHA256(secret, `${t}.${rawBody}`)` with `node:crypto`
 *                    (NO `stripe` SDK), constant-time compares each `v1` candidate,
 *                    and enforces the 5-minute timestamp tolerance.
 *  - `"hmac-hex"`  — Generic `HMAC_SHA256(secret, rawBody)` rendered as lowercase
 *                    hex, constant-time compared against the header value (e.g.
 *                    Segment's `x-signature`).
 */
export type SignatureScheme = "svix" | "stripe" | "hmac-hex";

export interface VerifySignatureArgs {
  rawBody: string;
  headers: Record<string, string>;
  secret: string;
}

const STRIPE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Lowercase every header key so callers can pass the raw (possibly Title-Case)
 * header record and we still find `svix-id` / `stripe-signature` / `x-signature`.
 */
function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = value;
  }
  return lowered;
}

/**
 * Constant-time string comparison that never short-circuits on length. Returns
 * `false` (rather than throwing) on a length mismatch so callers fail closed.
 * Exported so the connector ingress route reuses ONE hardened compare rather
 * than re-implementing `Buffer.from` + `timingSafeEqual` inline (where a later
 * refactor could drop the length guard and reintroduce the throw-on-mismatch).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function verifySvix(args: VerifySignatureArgs): boolean {
  const headers = lowerHeaders(args.headers);
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signature = headers["svix-signature"];

  if (!id || !timestamp || !signature) {
    return false;
  }

  try {
    const wh = new Webhook(args.secret);
    wh.verify(args.rawBody, {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    });
    return true;
  } catch {
    return false;
  }
}

function verifyStripe(args: VerifySignatureArgs): boolean {
  const headers = lowerHeaders(args.headers);
  const header = headers["stripe-signature"];
  if (!header) {
    return false;
  }

  // `t=1700000000,v1=<hex>,v1=<hex>` — there may be more than one v1 candidate
  // during a secret rotation and forward-compat `v0`/scheme fields we ignore.
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > STRIPE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", args.secret)
    .update(`${timestamp}.${args.rawBody}`)
    .digest("hex");

  return signatures.some((candidate) => safeEqual(candidate, expected));
}

function verifyHmacHex(args: VerifySignatureArgs, headerName: string): boolean {
  const headers = lowerHeaders(args.headers);
  const provided = headers[headerName.toLowerCase()];
  if (!provided) {
    return false;
  }

  const expected = createHmac("sha256", args.secret)
    .update(args.rawBody)
    .digest("hex");

  return safeEqual(provided.trim(), expected);
}

/**
 * Verify an inbound provider webhook signature for the given scheme.
 *
 * FAILS CLOSED: returns `false` (never throws) whenever a required header is
 * missing or the signature does not match. The route enforces that the secret
 * itself is present before calling this — an unset signature secret is a 401,
 * NOT an open pass-through (deliberate divergence from the `"match"` variant,
 * which stays open when unconfigured).
 *
 * For `"hmac-hex"` the header carrying the hex digest is passed via `headerName`
 * (e.g. Segment's `x-signature`); `svix`/`stripe` read their own well-known
 * headers and ignore `headerName`.
 */
export function verifySignature(
  scheme: SignatureScheme,
  args: VerifySignatureArgs,
  headerName?: string,
): boolean {
  switch (scheme) {
    case "svix":
      return verifySvix(args);
    case "stripe":
      return verifyStripe(args);
    case "hmac-hex":
      return verifyHmacHex(args, headerName ?? "x-signature");
    default: {
      // Exhaustiveness guard — an unknown scheme fails closed.
      const _never: never = scheme;
      return _never;
    }
  }
}
