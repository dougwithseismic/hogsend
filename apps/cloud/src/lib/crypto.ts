import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { env } from "../env";

/**
 * Envelope encryption for control-plane secrets (tenant provider keys today,
 * cell DSNs next). A PRIVATE mirror of the engine's
 * `packages/engine/src/lib/provider-credentials.ts` construction — same
 * AES-256-GCM, same sha256-derived key — with one addition: a VERSION PREFIX,
 * so a future construction (different KDF, KMS-wrapped key) can be introduced
 * without guessing at the shape of what is already in the column.
 *
 * Wire format: `v1:` + base64url(iv ‖ ciphertext ‖ authTag).
 *
 * Everything fails CLOSED: a tampered blob, a rotated secret, an unknown
 * version or a truncated body all raise `CloudDecryptError` rather than
 * returning a partial or empty payload.
 */

/** The only construction this module writes. Readers accept only this. */
export const CIPHERTEXT_VERSION = "v1";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
/** Mirrors the `min(32)` in `env.ts`; re-checked here so a direct caller passing
 * its own secret cannot slip under the floor. */
const MIN_SECRET_LENGTH = 32;

/**
 * Raised on ANY crypto failure. Deliberately carries no detail about WHY —
 * "wrong secret" vs "tampered" vs "truncated" is an oracle we owe no caller,
 * and every branch has the same remedy: re-enter the credential.
 */
export class CloudDecryptError extends Error {
  constructor(message = "Ciphertext could not be decrypted") {
    super(message);
    this.name = "CloudDecryptError";
  }
}

function deriveKey(secret: string): Buffer {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new CloudDecryptError(
      `Encryption secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return createHash("sha256").update(secret).digest();
}

/**
 * JSON-stringify + encrypt any value. `secret` defaults to
 * `CLOUD_ENCRYPTION_SECRET`; callers pass one explicitly only in tests and in
 * a future re-encrypt-under-new-key path.
 */
export function encryptSecretPayload(
  value: unknown,
  secret: string = env.CLOUD_ENCRYPTION_SECRET,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf-8"),
    cipher.final(),
  ]);
  const body = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    "base64url",
  );
  return `${CIPHERTEXT_VERSION}:${body}`;
}

/**
 * Decrypt + JSON.parse. The generic is an ASSERTION, not a validation — the
 * caller owns any shape checking (the provider-key service zod-parses the
 * result).
 */
export function decryptSecretPayload<T = unknown>(
  blob: string,
  secret: string = env.CLOUD_ENCRYPTION_SECRET,
): T {
  const separator = blob.indexOf(":");
  if (separator === -1) {
    throw new CloudDecryptError("Ciphertext is missing its version prefix");
  }
  const version = blob.slice(0, separator);
  if (version !== CIPHERTEXT_VERSION) {
    throw new CloudDecryptError(`Unsupported ciphertext version "${version}"`);
  }

  const raw = Buffer.from(blob.slice(separator + 1), "base64url");
  // `<=` not `<`: a blob that is EXACTLY iv+tag carries no ciphertext at all.
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new CloudDecryptError("Ciphertext is truncated");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH);
  const tag = raw.subarray(raw.length - TAG_LENGTH);

  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf-8");
    return JSON.parse(plaintext) as T;
  } catch (error) {
    // A short secret is a CONFIG error, not a tamper — let it through verbatim
    // so the operator sees the real cause.
    if (error instanceof CloudDecryptError) throw error;
    throw new CloudDecryptError();
  }
}
