import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, relayTokens } from "../db/schema";
import { env } from "../env";
import { type CloudWriter, writeAudit } from "./audit";
import { NotFoundError } from "./errors";

/**
 * The bearer credential a tenant instance presents to the email relay, one per
 * environment. Minted at provision time (PRD 06); this module owns its shape,
 * its storage and its verification.
 *
 * The laws:
 *  - the secret is returned EXACTLY ONCE, by the call that issues it. Nothing
 *    stored is a token — only its keyed hash — so nothing here can read one
 *    back. A customer who loses it rotates;
 *  - a rotation REPLACES (the unique index on `environment_id` is the upsert
 *    target), so the previous token stops being accepted the instant the new
 *    one is issued;
 *  - verification returns an ENVIRONMENT and nothing else. That environment is
 *    the only source of the SES tenant name a send is made under. A request
 *    body may not name its own tenant; if it could, tenant isolation would be
 *    advisory (DECISIONS §3.2);
 *  - the audit trail records that a token moved, never any part of the token.
 *    Not the hash, not `last4` — `last4` is a genuine substring of the secret
 *    and the audit log is a much wider-read surface than the token row.
 */

/** Every relay token starts with this, so a leaked one is greppable in a log. */
export const RELAY_TOKEN_PREFIX = "hsrel_";

/**
 * 32 bytes of CSPRNG entropy — 256 bits, the same floor as publish tokens and
 * the engine's API keys. base64url so the whole token pastes into a header and
 * a shell without quoting.
 */
const TOKEN_ENTROPY_BYTES = 32;

/** HMAC-SHA-256 hex is 64 characters; anything else is not one of ours. */
const TOKEN_HASH_LENGTH = 64;

const environmentInputSchema = z.object({
  environmentId: z.uuid(),
  actor: z.string().min(1).max(200).optional(),
});

const verifyInputSchema = z.object({
  // Bounded before it is hashed: an unbounded body must not become work.
  token: z.string().min(1).max(512),
});

export type RelayTokenTargetInput = z.input<typeof environmentInputSchema>;

/** Everything a dashboard may see. Never the token, never the hash. */
export interface RelayTokenSummary {
  id: string;
  environmentId: string;
  last4: string;
  createdAt: Date;
  rotatedAt: Date | null;
}

export interface IssueRelayTokenResult {
  /** The plaintext token. The ONLY time it exists outside a client. */
  token: string;
  summary: RelayTokenSummary;
  /** True when an existing token was replaced (and so stopped working). */
  replaced: boolean;
}

/** Mint-if-absent. Deliberately carries NO token — see `ensure()`. */
export interface EnsureRelayTokenResult {
  created: boolean;
  summary: RelayTokenSummary;
}

/**
 * Discriminated so "no such token" is an ordinary answer the caller must
 * handle rather than an exception it can forget to catch.
 */
export type VerifyRelayTokenResult =
  | { found: true; environmentId: string; tokenId: string }
  | { found: false };

/** A fresh, never-before-issued token. */
export function generateRelayToken(): string {
  return `${RELAY_TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
}

/**
 * The one-way transform, and the ONLY form of a relay token this app persists.
 *
 * KEYED (HMAC-SHA-256 under `CLOUD_ENCRYPTION_SECRET`) rather than a bare
 * sha256: a stolen database alone then cannot confirm a guessed token offline,
 * because confirming it needs the key too. NOT a password KDF — the token is
 * 32 bytes of CSPRNG output, so there is no dictionary to mount against it, and
 * a per-request bcrypt would price the relay out at journey fan-out volumes.
 * The comparison below is still constant-time, because that is free.
 */
export function hashRelayToken(
  token: string,
  secret: string = env.CLOUD_ENCRYPTION_SECRET,
): string {
  return createHmac("sha256", secret).update(token, "utf-8").digest("hex");
}

/** Display tail: the last four characters of the secret body. */
export function relayTokenLast4(token: string): string {
  return token.slice(-4);
}

type RelayTokenRow = typeof relayTokens.$inferSelect;

function toSummary(row: RelayTokenRow): RelayTokenSummary {
  return {
    id: row.id,
    environmentId: row.environmentId,
    last4: row.last4,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
  };
}

/**
 * Issue a token for `environmentId` on the caller's writer, replacing any
 * existing one.
 *
 * Exported as a plain function (not only a method) so PRD 06's provisioning can
 * mint INSIDE the transaction that provisions the SES tenant — an environment
 * with an SES tenant but no relay token would be one nothing could send
 * through.
 */
export async function insertRelayToken(
  writer: CloudWriter,
  input: { environmentId: string },
): Promise<{ token: string; row: RelayTokenRow }> {
  const token = generateRelayToken();
  const [row] = await writer
    .insert(relayTokens)
    .values({
      environmentId: input.environmentId,
      tokenHash: hashRelayToken(token),
      last4: relayTokenLast4(token),
    })
    .onConflictDoUpdate({
      target: relayTokens.environmentId,
      set: {
        tokenHash: hashRelayToken(token),
        last4: relayTokenLast4(token),
        rotatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error(
      `Failed to issue a relay token for environment ${input.environmentId}`,
    );
  }
  return { token, row };
}

export class RelayTokenService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * Issue a token, replacing any existing one. The returned `token` is the only
   * copy that will ever exist outside the caller.
   */
  async mint(input: RelayTokenTargetInput): Promise<IssueRelayTokenResult> {
    const { environmentId, actor } = environmentInputSchema.parse(input);

    return this.db.transaction(async (tx) => {
      const organizationId = await lockEnvironmentOrganization(
        tx,
        environmentId,
      );
      const existing = await findByEnvironment(tx, environmentId);
      const { token, row } = await insertRelayToken(tx, { environmentId });

      await writeAudit(tx, {
        actor,
        organizationId,
        action: existing ? "relay_token.rotated" : "relay_token.minted",
        subject: row.id,
        // WHICH token moved, never WHAT it is: no hash, no last4.
        detail: { environmentId },
      });

      return {
        token,
        summary: toSummary(row),
        replaced: existing !== undefined,
      };
    });
  }

  /**
   * Replace an EXISTING token. Refuses when there is none, because "rotate"
   * promises the old credential stops working and there is no old credential to
   * make that promise about — the caller wanted `mint`.
   */
  async rotate(input: RelayTokenTargetInput): Promise<IssueRelayTokenResult> {
    const { environmentId } = environmentInputSchema.parse(input);
    const existing = await findByEnvironment(this.db, environmentId);
    if (!existing) throw new NotFoundError("Relay token", environmentId);
    return this.mint(input);
  }

  /**
   * Guarantee this environment HAS a token, without issuing one anybody holds.
   *
   * The secret it generates is discarded on purpose: `ensure` is called from a
   * page read, and a secret that reached a render would be a secret shown more
   * than once. What it buys is that `rotate` — the only surface that hands a
   * customer a usable token — always has a row to replace.
   */
  async ensure(input: {
    environmentId: string;
  }): Promise<EnsureRelayTokenResult> {
    const { environmentId } = environmentInputSchema.parse(input);

    const existing = await findByEnvironment(this.db, environmentId);
    if (existing) return { created: false, summary: toSummary(existing) };

    return this.db.transaction(async (tx) => {
      const organizationId = await lockEnvironmentOrganization(
        tx,
        environmentId,
      );
      // Re-read under the lock: two concurrent page loads must not both mint.
      const raced = await findByEnvironment(tx, environmentId);
      if (raced) return { created: false, summary: toSummary(raced) };

      const { row } = await insertRelayToken(tx, { environmentId });
      await writeAudit(tx, {
        actor: "system",
        organizationId,
        action: "relay_token.minted",
        subject: row.id,
        detail: { environmentId, reason: "backfill" },
      });
      return { created: true, summary: toSummary(row) };
    });
  }

  /**
   * Which environment (if any) this token may send for.
   *
   * The lookup is by HASH, so the plaintext is never compared against anything
   * and a database read can never surface a credential. The `timingSafeEqual`
   * below is the belt to that braces: the index lookup FINDS the row, and this
   * is what ACCEPTS it, so acceptance is not decided by a short-circuiting
   * `===` over attacker-influenced bytes.
   */
  async verify(input: { token: string }): Promise<VerifyRelayTokenResult> {
    const parsed = verifyInputSchema.safeParse(input);
    if (!parsed.success) return { found: false };

    const hash = hashRelayToken(parsed.data.token);
    const [row] = await this.db
      .select({
        id: relayTokens.id,
        environmentId: relayTokens.environmentId,
        tokenHash: relayTokens.tokenHash,
      })
      .from(relayTokens)
      .where(eq(relayTokens.tokenHash, hash))
      .limit(1);

    if (!row || !hashesMatch(hash, row.tokenHash)) return { found: false };
    return { found: true, environmentId: row.environmentId, tokenId: row.id };
  }

  /** The token metadata for one environment, or null. Never the secret. */
  async get(input: {
    environmentId: string;
  }): Promise<RelayTokenSummary | null> {
    const { environmentId } = environmentInputSchema.parse(input);
    const row = await findByEnvironment(this.db, environmentId);
    return row ? toSummary(row) : null;
  }
}

/** Length-safe constant-time comparison of two hex digests. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== TOKEN_HASH_LENGTH || b.length !== TOKEN_HASH_LENGTH) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

async function findByEnvironment(
  writer: CloudWriter,
  environmentId: string,
): Promise<RelayTokenRow | undefined> {
  const [row] = await writer
    .select()
    .from(relayTokens)
    .where(eq(relayTokens.environmentId, environmentId))
    .limit(1);
  return row;
}

/**
 * The environment's organization, with the row locked.
 *
 * Two jobs in one statement: it is where a missing environment becomes a typed
 * `NotFoundError` rather than a foreign-key violation, and the lock serialises
 * concurrent issues for one environment so the upsert cannot interleave with
 * the "did one already exist?" read that decides the audit verb.
 */
async function lockEnvironmentOrganization(
  writer: CloudWriter,
  environmentId: string,
): Promise<string> {
  const [row] = await writer
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundError("Environment", environmentId);
  return row.organizationId;
}
