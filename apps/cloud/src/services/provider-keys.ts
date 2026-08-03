import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cloudAuditLog, providerKeys } from "../db/schema";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";

/**
 * Tenant provider credentials (resend / postmark / posthog / twilio / …), one
 * row per (environment, provider).
 *
 * The invariants this service exists to hold:
 *  - plaintext NEVER leaves this module except through `getDecrypted`;
 *  - `list()` is the ONLY shape any UI/API sees, and it carries no ciphertext;
 *  - every mutation appends a `cloud_audit_log` row whose detail contains no
 *    secret material — not the payload, not the ciphertext, not even `last4`
 *    (which is a genuine substring of the secret, and the audit log is a much
 *    wider-read surface than the key row itself);
 *  - a re-store REPLACES rather than accumulates (the unique index
 *    `provider_keys_environment_provider_unique_idx` is the conflict target),
 *    and clears `verified_at` — the new credential has not been proven yet.
 */

/**
 * A credential payload is a flat string map: whatever fields the engine's
 * plugin for that provider expects (`apiKey`, `fromEmail`, `accountSid`, …).
 * The control plane deliberately does NOT model per-provider shapes — it stores
 * an opaque bag and the engine validates it at use time.
 */
export const providerKeyPayloadSchema = z
  .record(z.string().min(1), z.string())
  .refine((value) => Object.keys(value).length > 0, {
    message: "Payload must contain at least one field",
  });

export type ProviderKeyPayload = z.infer<typeof providerKeyPayloadSchema>;

const providerSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Provider must be a lowercase plugin id");

const actorSchema = z.string().min(1).max(200).default("system");

const storeInputSchema = z.object({
  organizationId: z.string().min(1),
  environmentId: z.uuid(),
  provider: providerSchema,
  payload: providerKeyPayloadSchema,
  actor: actorSchema.optional(),
});

const targetInputSchema = z.object({
  environmentId: z.uuid(),
  provider: providerSchema,
  actor: actorSchema.optional(),
});

const listInputSchema = z.object({ environmentId: z.uuid() });

export type StoreProviderKeyInput = z.input<typeof storeInputSchema>;
export type ProviderKeyTargetInput = z.input<typeof targetInputSchema>;

/** The safe projection — everything a dashboard may see. Never the payload. */
export interface ProviderKeySummary {
  id: string;
  organizationId: string;
  environmentId: string;
  provider: string;
  last4: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type StoreProviderKeyResult = {
  key: ProviderKeySummary;
  /** True when an existing credential was overwritten. */
  replaced: boolean;
};

export type ListProviderKeysResult = { keys: ProviderKeySummary[] };

/**
 * Discriminated so "no credential stored" is an ordinary answer a caller must
 * handle, not an exception it can forget to catch. A DECRYPT failure is the
 * opposite — it throws `CloudDecryptError`, because silently reporting a
 * tampered row as "not found" would hide an attack.
 */
export type GetDecryptedResult =
  | { found: true; provider: string; payload: ProviderKeyPayload }
  | { found: false };

export type RemoveProviderKeyResult = { removed: boolean };
export type MarkVerifiedResult =
  | { found: true; key: ProviderKeySummary }
  | { found: false };

/**
 * Field names that hold the actual secret, most-specific first. `last4` is
 * taken from the first one present; when a payload uses none of them we fall
 * back to the longest value, which in practice is still the credential rather
 * than a region or an email.
 */
const SECRET_FIELDS = [
  "apiKey",
  "api_key",
  "secretKey",
  "serverToken",
  "authToken",
  "accessToken",
  "token",
  "secret",
  "password",
  "key",
] as const;

function primarySecret(payload: ProviderKeyPayload): string | undefined {
  for (const field of SECRET_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const values = Object.values(payload).filter((v) => v.length > 0);
  if (values.length === 0) return undefined;
  return values.reduce((longest, v) =>
    v.length > longest.length ? v : longest,
  );
}

/** Display tail. Null when there is nothing meaningful to show. */
export function computeLast4(payload: ProviderKeyPayload): string | null {
  const secret = primarySecret(payload);
  if (!secret || secret.length < 4) return null;
  return secret.slice(-4);
}

type ProviderKeyRow = typeof providerKeys.$inferSelect;

function toSummary(row: ProviderKeyRow): ProviderKeySummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    environmentId: row.environmentId,
    provider: row.provider,
    last4: row.last4,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ProviderKeyService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * Encrypt + UPSERT. The payload is a FULL overwrite (the store stays dumb —
   * merging an old field into a new submission is the caller's job), and
   * `verified_at` resets to null because the stored bytes changed.
   */
  async store(input: StoreProviderKeyInput): Promise<StoreProviderKeyResult> {
    const { organizationId, environmentId, provider, payload, actor } =
      storeInputSchema.parse(input);

    const existing = await this.findRow(environmentId, provider);
    const encryptedPayload = encryptSecretPayload(payload);

    const [row] = await this.db
      .insert(providerKeys)
      .values({
        organizationId,
        environmentId,
        provider,
        encryptedPayload,
        last4: computeLast4(payload),
      })
      .onConflictDoUpdate({
        target: [providerKeys.environmentId, providerKeys.provider],
        set: {
          organizationId,
          encryptedPayload,
          last4: computeLast4(payload),
          // A replaced credential is unproven until re-checked.
          verifiedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new Error(
        `Failed to store provider key "${provider}" for environment ${environmentId}`,
      );
    }

    await this.audit({
      actor,
      organizationId: row.organizationId,
      action: "provider_key.stored",
      subject: row.id,
      detail: { provider, environmentId, replaced: existing !== undefined },
    });

    return { key: toSummary(row), replaced: existing !== undefined };
  }

  /** Metadata for one environment's credentials. Carries no ciphertext. */
  async list(input: {
    environmentId: string;
  }): Promise<ListProviderKeysResult> {
    const { environmentId } = listInputSchema.parse(input);

    // Column-projected rather than `select()`-then-map: the ciphertext must not
    // even be fetched, so a future refactor cannot leak it by accident.
    const rows = await this.db
      .select({
        id: providerKeys.id,
        organizationId: providerKeys.organizationId,
        environmentId: providerKeys.environmentId,
        provider: providerKeys.provider,
        last4: providerKeys.last4,
        verifiedAt: providerKeys.verifiedAt,
        createdAt: providerKeys.createdAt,
        updatedAt: providerKeys.updatedAt,
      })
      .from(providerKeys)
      .where(eq(providerKeys.environmentId, environmentId))
      .orderBy(providerKeys.provider);

    return { keys: rows };
  }

  /**
   * Round-trip the exact payload that was stored. Throws `CloudDecryptError`
   * when the row exists but the ciphertext is tampered or the secret rotated.
   */
  async getDecrypted(
    input: Omit<ProviderKeyTargetInput, "actor">,
  ): Promise<GetDecryptedResult> {
    const { environmentId, provider } = targetInputSchema.parse(input);
    const row = await this.findRow(environmentId, provider);
    if (!row) return { found: false };

    const payload = providerKeyPayloadSchema.parse(
      decryptSecretPayload(row.encryptedPayload),
    );
    return { found: true, provider: row.provider, payload };
  }

  /** Hard-delete. Never decrypts — this is the escape hatch after a rotation. */
  async remove(
    input: ProviderKeyTargetInput,
  ): Promise<RemoveProviderKeyResult> {
    const { environmentId, provider, actor } = targetInputSchema.parse(input);

    const [row] = await this.db
      .delete(providerKeys)
      .where(
        and(
          eq(providerKeys.environmentId, environmentId),
          eq(providerKeys.provider, provider),
        ),
      )
      .returning({
        id: providerKeys.id,
        organizationId: providerKeys.organizationId,
      });

    if (!row) return { removed: false };

    await this.audit({
      actor,
      organizationId: row.organizationId,
      action: "provider_key.removed",
      subject: row.id,
      detail: { provider, environmentId },
    });

    return { removed: true };
  }

  /** Stamp a successful live credential check. */
  async markVerified(
    input: ProviderKeyTargetInput,
  ): Promise<MarkVerifiedResult> {
    const { environmentId, provider, actor } = targetInputSchema.parse(input);
    const verifiedAt = new Date();

    const [row] = await this.db
      .update(providerKeys)
      .set({ verifiedAt, updatedAt: verifiedAt })
      .where(
        and(
          eq(providerKeys.environmentId, environmentId),
          eq(providerKeys.provider, provider),
        ),
      )
      .returning();

    if (!row) return { found: false };

    await this.audit({
      actor,
      organizationId: row.organizationId,
      action: "provider_key.verified",
      subject: row.id,
      detail: { provider, environmentId },
    });

    return { found: true, key: toSummary(row) };
  }

  private async findRow(
    environmentId: string,
    provider: string,
  ): Promise<ProviderKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.environmentId, environmentId),
          eq(providerKeys.provider, provider),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * The audit contract for this service: detail carries WHICH credential moved,
   * never WHAT it is. `last4` is deliberately excluded — see the module docs.
   */
  private async audit(entry: {
    actor: string | undefined;
    organizationId: string;
    action: string;
    subject: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(cloudAuditLog).values({
      actor: entry.actor ?? "system",
      organizationId: entry.organizationId,
      action: entry.action,
      subject: entry.subject,
      detail: entry.detail,
    });
  }
}

/** Default instance bound to the app pool — the usual import for callers. */
export const providerKeyService = new ProviderKeyService();
