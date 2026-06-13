import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { type Database, providerCredentials } from "@hogsend/db";
import { and, eq } from "drizzle-orm";
import { env } from "../env.js";

/**
 * Provider-neutral credential storage: encrypted-at-rest OAuth tokens (and,
 * later, API keys) in the `provider_credentials` table. The crypto is a
 * PRIVATE mirror of `identity-token.ts` (same AES-256-GCM construction, no
 * shared module — identity tokens bake an `exp` into the payload; credentials
 * don't, so the two stay independent).
 */

/**
 * "oauth" holds the token grant; "derived" holds server-derived config grabbed
 * during connect. Widen the union further when an "api_key" kind lands.
 */
export type CredentialKind = "oauth" | "derived";

/**
 * The decrypted shape stored for kind="oauth". Provider-neutral: nothing in
 * here is PostHog-specific. `expiresAt` is ISO-8601 with offset (access-token
 * expiry); `tokenEndpoint` is captured at connect time so refresh never
 * re-runs discovery; `clientId` is the client identifier used at connect so
 * refresh can re-send it; `scopedTeams`/`scopedOrganizations` mirror what an
 * authorization server reports at consent time (PostHog: numeric team ids,
 * UUID organization ids) — empty when the grant is unscoped.
 */
export interface OAuthCredentialPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  scopedTeams: number[];
  scopedOrganizations: string[];
}

/**
 * The decrypted shape stored for kind="derived": server-derived PostHog config
 * grabbed during connect. `webhookSecret` is minted when env lacks one
 * (load-bearing for the inbound loop — the posthog webhook source resolves it
 * from the store at request time); `projectApiKey` (phc_) is grabbed
 * opportunistically for the OPTIONAL outbound capture path. All fields optional.
 */
export interface DerivedCredentialPayload {
  webhookSecret?: string;
  projectApiKey?: string;
  projectId?: string;
  privateHost?: string;
}

/** Row metadata — everything EXCEPT token material. Safe to surface. */
export interface ProviderCredentialMeta {
  providerId: string;
  kind: CredentialKind;
  scopes: string[];
  expiresAt: Date;
  scopedTeams: number[];
  createdAt: Date;
  updatedAt: Date;
}

/** Full decrypted record for engine-internal callers (token lifecycle). */
export interface DecryptedProviderCredential {
  providerId: string;
  kind: CredentialKind;
  payload: OAuthCredentialPayload;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Thrown when a stored payload fails to decrypt or parse — in practice this
 * means BETTER_AUTH_SECRET rotated (or the row was tampered with). LOUD by
 * design: callers must not silently fall back, the operator needs to
 * reconnect (`hogsend connect <providerId>`) or DELETE the credential.
 */
export class ProviderCredentialDecryptError extends Error {
  constructor(providerId: string) {
    super(
      `Stored credential for "${providerId}" cannot be decrypted — ` +
        `BETTER_AUTH_SECRET may have rotated. Re-connect the provider or ` +
        `delete the credential.`,
    );
    this.name = "ProviderCredentialDecryptError";
  }
}

// --- crypto (mirrors lib/identity-token.ts: AES-256-GCM, sha256-derived key,
// --- base64url(iv || ciphertext || tag)) ----------------------------------
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/**
 * Payload-agnostic encrypt: JSON-stringify any value, AES-256-GCM encrypt,
 * return base64url(iv || ciphertext || tag). No shape validation — the kind's
 * own encrypt helper owns that.
 */
function encryptJson(value: unknown, secret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf-8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    "base64url",
  );
}

/**
 * Payload-agnostic decrypt: decode base64url, AES-256-GCM decrypt, JSON.parse.
 * Throws `ProviderCredentialDecryptError` on ANY failure or if the parsed
 * result is not a non-null object. Per-kind validation lives in the caller.
 */
function decryptJson(
  blob: string,
  secret: string,
  providerId: string,
): unknown {
  let raw: Buffer;
  try {
    raw = Buffer.from(blob, "base64url");
  } catch {
    throw new ProviderCredentialDecryptError(providerId);
  }
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new ProviderCredentialDecryptError(providerId);
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH);
  const tag = raw.subarray(raw.length - TAG_LENGTH);

  let value: unknown;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf-8");
    value = JSON.parse(plaintext);
  } catch {
    throw new ProviderCredentialDecryptError(providerId);
  }

  if (typeof value !== "object" || value === null) {
    throw new ProviderCredentialDecryptError(providerId);
  }
  return value;
}

function encryptPayload(
  payload: OAuthCredentialPayload,
  secret: string,
): string {
  return encryptJson(payload, secret);
}

function decryptPayload(
  blob: string,
  secret: string,
  providerId: string,
): OAuthCredentialPayload {
  const payload = decryptJson(
    blob,
    secret,
    providerId,
  ) as OAuthCredentialPayload;

  if (
    typeof payload.accessToken !== "string" ||
    typeof payload.tokenEndpoint !== "string"
  ) {
    throw new ProviderCredentialDecryptError(providerId);
  }
  return payload;
}

/** Meta projection — keeps the tokens-never-surfaced shape in ONE place. */
export function toCredentialMeta(
  record: DecryptedProviderCredential,
): ProviderCredentialMeta {
  return {
    providerId: record.providerId,
    kind: record.kind,
    scopes: record.payload.scopes,
    expiresAt: new Date(record.payload.expiresAt),
    scopedTeams: record.payload.scopedTeams,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Read + decrypt one credential. `null` when none stored; throws
 * `ProviderCredentialDecryptError` when a row exists but cannot be decrypted.
 */
export async function getProviderCredential(
  db: Database,
  providerId: string,
  kind: CredentialKind = "oauth",
): Promise<DecryptedProviderCredential | null> {
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.providerId, providerId),
        eq(providerCredentials.kind, kind),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    providerId: row.providerId,
    kind: row.kind as CredentialKind,
    payload: decryptPayload(row.payload, env.BETTER_AUTH_SECRET, providerId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Encrypt + UPSERT (full-payload overwrite, deliberately: "keep the old
 * refresh token when the token response omits one" is the CALLER's merge job
 * — the store stays dumb). Returns the safe meta projection.
 */
export async function saveProviderCredential(
  db: Database,
  opts: {
    providerId: string;
    kind?: CredentialKind;
    payload: OAuthCredentialPayload;
  },
): Promise<ProviderCredentialMeta> {
  const kind = opts.kind ?? "oauth";
  const encrypted = encryptPayload(opts.payload, env.BETTER_AUTH_SECRET);

  const [row] = await db
    .insert(providerCredentials)
    .values({ providerId: opts.providerId, kind, payload: encrypted })
    .onConflictDoUpdate({
      target: [providerCredentials.providerId, providerCredentials.kind],
      set: { payload: encrypted, updatedAt: new Date() },
    })
    .returning();

  if (!row) {
    throw new Error(
      `Failed to save provider credential for "${opts.providerId}"`,
    );
  }

  return toCredentialMeta({
    providerId: row.providerId,
    kind: row.kind as CredentialKind,
    payload: opts.payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Hard-delete. `true` iff a row was removed. Never decrypts — this is the
 * operator's escape hatch after a secret rotation.
 */
export async function deleteProviderCredential(
  db: Database,
  providerId: string,
  kind: CredentialKind = "oauth",
): Promise<boolean> {
  const deleted = await db
    .delete(providerCredentials)
    .where(
      and(
        eq(providerCredentials.providerId, providerId),
        eq(providerCredentials.kind, kind),
      ),
    )
    .returning({ id: providerCredentials.id });

  return deleted.length > 0;
}

/**
 * Read + decrypt the kind="derived" config for a provider. `null` when none
 * stored; throws `ProviderCredentialDecryptError` when a row exists but cannot
 * be decrypted. Unlike the oauth path there's no required-field validation —
 * every field on `DerivedCredentialPayload` is optional.
 */
export async function getDerivedCredential(
  db: Database,
  providerId: string,
): Promise<DerivedCredentialPayload | null> {
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.providerId, providerId),
        eq(providerCredentials.kind, "derived"),
      ),
    )
    .limit(1);

  if (!row) return null;

  return decryptJson(
    row.payload,
    env.BETTER_AUTH_SECRET,
    providerId,
  ) as DerivedCredentialPayload;
}

/**
 * Encrypt + UPSERT the kind="derived" config (full-payload overwrite, same dumb
 * store as `saveProviderCredential`: merging old + new fields is the CALLER's
 * job).
 */
export async function saveDerivedCredential(
  db: Database,
  providerId: string,
  payload: DerivedCredentialPayload,
): Promise<void> {
  const encrypted = encryptJson(payload, env.BETTER_AUTH_SECRET);

  await db
    .insert(providerCredentials)
    .values({ providerId, kind: "derived", payload: encrypted })
    .onConflictDoUpdate({
      target: [providerCredentials.providerId, providerCredentials.kind],
      set: { payload: encrypted, updatedAt: new Date() },
    });
}
