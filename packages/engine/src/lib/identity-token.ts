import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Short-lived identity token appended to tracked-link redirects as `hs_t`
 * (opt-in via TRACKING_IDENTITY_TOKEN). The landing site exchanges it at
 * `POST /v1/t/identify` for the distinct id and calls `posthog.identify` —
 * stitching the email click to the web session.
 *
 * ENCRYPTED (AES-256-GCM keyed off BETTER_AUTH_SECRET), not merely signed:
 * the distinct id can fall back to an email address, and a signed-but-
 * readable token would put a base64-decodable email in the URL — into
 * browser history, referrers, and any script on the landing page. The GCM
 * auth tag also covers integrity, so tampering fails decryption.
 */

export interface IdentityTokenPayload {
  /** The distinct id the landing site should identify as. */
  distinctId: string;
  emailSendId: string;
  exp: number;
}

export class InvalidIdentityTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdentityTokenError";
  }
}

const DEFAULT_EXPIRY_SECONDS = 60 * 60; // 1 hour — a click-to-landing hop
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function generateIdentityToken(opts: {
  secret: string;
  distinctId: string;
  emailSendId: string;
  expiresInSeconds?: number;
}): string {
  const payload: IdentityTokenPayload = {
    distinctId: opts.distinctId,
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
  return payload;
}
