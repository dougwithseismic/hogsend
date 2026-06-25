import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The publishable-key `userToken` — a short-lived HMAC over a `userId`, signed
 * with `BETTER_AUTH_SECRET` (the same trust root as the `hs_t` identity token).
 *
 * Unlike `hs_t` (AES-256-GCM ENCRYPTED, because it can carry an email), this
 * token is SIGNED-NOT-ENCRYPTED: it carries only a `userId` the integrating
 * server already knows and chose to assert, so there is no PII to hide — only
 * integrity (a browser must not be able to forge another person's userId) to
 * guarantee.
 *
 * v1 use: a publishable (pk_) key is ANON-ONLY by default. To act on a concrete
 * `userId`, the browser must present a `userToken` the integrating server minted
 * SERVER-SIDE (v3 ships the mint helper into the SDK / a signing endpoint). In
 * v1 the VERIFY function exists and is wired into every publishable-reachable
 * handler, but with no mint path exposed a pk_ key is effectively anon-only —
 * the secure default, and the point.
 */

export interface UserTokenPayload {
  userId: string;
  exp: number;
}

export class InvalidUserTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUserTokenError";
  }
}

const DEFAULT_EXPIRY_SECONDS = 60 * 60; // 1 hour

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * MINT helper — v3. Present but UNUSED by the engine in v1 (publishable keys are
 * anon-only by default). Wired here so v3 can expose a signer (SDK / endpoint)
 * without re-touching the verify path. Produces `<base64url(payload)>.<sig>`.
 */
export function generateUserToken(opts: {
  secret: string;
  userId: string;
  expiresInSeconds?: number;
}): string {
  const payload: UserTokenPayload = {
    userId: opts.userId,
    exp:
      Math.floor(Date.now() / 1000) +
      (opts.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(opts.secret, body)}`;
}

/**
 * VERIFY: parse `<base64url(payload)>.<sig>`, verify the HMAC in constant time,
 * and check expiry. Throws {@link InvalidUserTokenError} on any failure
 * (malformed, bad signature, bad payload shape, expired).
 */
export function verifyUserToken(opts: {
  token: string;
  secret: string;
}): UserTokenPayload {
  const [body, sig] = opts.token.split(".");
  if (!body || !sig) throw new InvalidUserTokenError("Malformed token");

  const expected = sign(opts.secret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check first — `timingSafeEqual` throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidUserTokenError("Bad signature");
  }

  let payload: UserTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    throw new InvalidUserTokenError("Bad token");
  }

  if (typeof payload.userId !== "string" || typeof payload.exp !== "number") {
    throw new InvalidUserTokenError("Invalid payload shape");
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new InvalidUserTokenError("Token expired");
  }
  return payload;
}
