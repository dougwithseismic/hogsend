import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Short-lived identity token appended to tracked-link redirects as `hs_t`
 * (opt-in via TRACKING_IDENTITY_TOKEN). The landing site exchanges it at
 * `POST /v1/t/identify`, where the engine fires a SERVER-SIDE `alias` folding
 * the caller's own anon session into the token's canonical id — stitching the
 * click to the web session. Minted for EMAIL links by default; non-email
 * (Discord/referral) links carry a token only when explicitly stitch-bearing
 * (`tracked_links.distinct_id` set) — referral links are token-less by default
 * (MF-4 anti-hijack).
 *
 * ENCRYPTED (AES-256-GCM keyed off BETTER_AUTH_SECRET), not merely signed:
 * the distinct id can fall back to an email address, and a signed-but-
 * readable token would put a base64-decodable email in the URL — into
 * browser history, referrers, and any script on the landing page. The GCM
 * auth tag also covers integrity, so tampering fails decryption.
 */

/**
 * The only merge mode a token may authorize: fold the CALLER's own anonymous
 * session INTO the token's canonical `distinctId`. There is deliberately no
 * "become the subject" / overwrite mode — that is the anti-hijack invariant.
 */
export type IdentityTokenScope = "anon-absorb";

export interface IdentityTokenPayload {
  /**
   * The canonical contact key the landing site should fold INTO — the ONLY
   * ever-identified id. NEVER a per-link or anonymous id.
   */
  distinctId: string;
  /**
   * Where the token was minted: `"email:<sendId>"` | `"link:<linkId>"`.
   * Referral links are excluded by default (they carry no identity token).
   */
  src: string;
  /**
   * The authorized merge mode. Only `"anon-absorb"` is ever minted. OPTIONAL on
   * the wire for the rolling-deploy window (MF-7): a token minted by the still-old
   * click route carries no `scope`, so `validateIdentityToken` treats a MISSING
   * scope as `"anon-absorb"` (allow) and rejects only a PRESENT-and-wrong value.
   */
  scope?: IdentityTokenScope;
  exp: number;
  /**
   * @deprecated Alias of `src` for ONE minor (mirrors the `resendId` → `messageId`
   * deprecation window). Old tokens carry only `emailSendId`; new email tokens
   * carry both. Reads should prefer `src`.
   */
  emailSendId?: string;
}

export class InvalidIdentityTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdentityTokenError";
  }
}

const DEFAULT_EXPIRY_SECONDS = 60 * 60; // 1 hour — a click-to-landing hop
/**
 * The single-use burn sentinel (`POST /v1/t/identify`) lives in Redis for the
 * token's full validity window, so a reshared token can't replay a merge while
 * it would still validate. Kept equal to the token lifetime.
 */
export const IDENTITY_TOKEN_TTL_SECONDS = DEFAULT_EXPIRY_SECONDS;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function generateIdentityToken(opts: {
  secret: string;
  distinctId: string;
  /**
   * Mint provenance: `"email:<sendId>"` | `"link:<linkId>"`. When omitted, falls
   * back to `email:<emailSendId>` for the legacy email-link caller.
   */
  src?: string;
  /** Defaults to `"anon-absorb"` — the only mode a token may authorize. */
  scope?: IdentityTokenScope;
  /**
   * @deprecated Pass `src` instead. Kept for the one-minor deprecation window so
   * existing email-link callers compile unchanged; mirrored into the payload's
   * deprecated `emailSendId` field and used to synthesize `src` when `src` is
   * absent.
   */
  emailSendId?: string;
  expiresInSeconds?: number;
}): string {
  const src = opts.src ?? (opts.emailSendId ? `email:${opts.emailSendId}` : "");
  const payload: IdentityTokenPayload = {
    distinctId: opts.distinctId,
    src,
    scope: opts.scope ?? "anon-absorb",
    emailSendId: opts.emailSendId,
    exp:
      Math.floor(Date.now() / 1000) +
      (opts.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS),
  };
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(opts.secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf-8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    "base64url",
  );
}

export function validateIdentityToken(opts: {
  token: string;
  secret: string;
}): IdentityTokenPayload {
  let raw: Buffer;
  try {
    raw = Buffer.from(opts.token, "base64url");
  } catch {
    throw new InvalidIdentityTokenError("Malformed token");
  }
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new InvalidIdentityTokenError("Malformed token");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH);
  const tag = raw.subarray(raw.length - TAG_LENGTH);

  let payload: IdentityTokenPayload;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(opts.secret),
      iv,
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf-8");
    payload = JSON.parse(plaintext);
  } catch {
    throw new InvalidIdentityTokenError("Bad token");
  }

  if (
    typeof payload.distinctId !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new InvalidIdentityTokenError("Invalid payload shape");
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new InvalidIdentityTokenError("Token expired");
  }
  // MF-7 — missing-scope-ALLOW. The API and worker deploy independently from
  // the same image, so a token minted by the still-old click route carries no
  // `scope`. Treat a MISSING scope as the only legal mode (`"anon-absorb"`);
  // reject ONLY a present-and-wrong value. Old tokens (no `scope`, no `src`)
  // still validate — this check never widened the required-shape gate above.
  if (payload.scope !== undefined && payload.scope !== "anon-absorb") {
    throw new InvalidIdentityTokenError("Unsupported token scope");
  }
  // Backfill `src` from the deprecated `emailSendId` for old tokens, so the one
  // response schema (`{ distinctId, src, emailSendId? }`) is always populated.
  if (typeof payload.src !== "string" || payload.src.length === 0) {
    payload.src = payload.emailSendId ? `email:${payload.emailSendId}` : "";
  }
  return payload;
}
