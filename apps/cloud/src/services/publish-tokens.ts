import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, publishTokens } from "../db/schema";
import { type CloudWriter, writeAudit } from "./audit";
import { NotFoundError } from "./errors";

/**
 * The bearer credential `hogsend publish` uploads with, one per environment.
 *
 * The laws this module exists to hold:
 *  - the secret is returned EXACTLY ONCE, by the call that issues it. Nothing
 *    here can read a stored token back, because nothing stored is a token —
 *    only its sha256. A customer who loses it rotates;
 *  - a rotation REPLACES (the unique index on `environment_id` is the upsert
 *    target), so the previous token stops being accepted the instant the new
 *    one is issued. Two live tokens for one environment would make "revoke" a
 *    lie;
 *  - the audit trail records that a token moved, never any part of the token.
 *    Not the hash, not `last4` — the audit log is a much wider-read surface
 *    than the token row, and `last4` is a genuine substring of the secret.
 */

/** Every token starts with this, so a leaked one is greppable in a log. */
export const PUBLISH_TOKEN_PREFIX = "hspub_";

/**
 * 32 bytes of CSPRNG entropy — 256 bits, the same floor as the engine's API
 * keys. base64url so the whole token is copy-pasteable into a header and a
 * shell without quoting.
 */
const TOKEN_ENTROPY_BYTES = 32;

/** sha256 hex is 64 characters; anything else is not one of ours. */
const TOKEN_HASH_LENGTH = 64;

const environmentInputSchema = z.object({
  environmentId: z.uuid(),
  actor: z.string().min(1).max(200).optional(),
});

const verifyInputSchema = z.object({
  // Bounded before it is hashed: an unbounded body must not become work.
  token: z.string().min(1).max(512),
});

export type PublishTokenTargetInput = z.input<typeof environmentInputSchema>;

/** Everything a dashboard may see. Never the token, never the hash. */
export interface PublishTokenSummary {
  id: string;
  environmentId: string;
  last4: string;
  createdAt: Date;
  rotatedAt: Date | null;
}

export interface IssuePublishTokenResult {
  /** The plaintext token. This is the ONLY time it exists outside a client. */
  token: string;
  summary: PublishTokenSummary;
  /** True when an existing token was replaced (and so stopped working). */
  replaced: boolean;
}

/** Mint-if-absent. Deliberately carries NO token — see `ensure()`. */
export interface EnsurePublishTokenResult {
  created: boolean;
  summary: PublishTokenSummary;
}

/**
 * Discriminated so "no such token" is an ordinary answer the caller must
 * handle rather than an exception it can forget to catch.
 */
export type VerifyPublishTokenResult =
  | { found: true; environmentId: string; tokenId: string }
  | { found: false };

/** A fresh, never-before-issued token. */
export function generatePublishToken(): string {
  return `${PUBLISH_TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
}

/** The one-way transform. The ONLY form of a token this app persists. */
export function hashPublishToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/** Display tail: the last four characters of the secret body. */
export function publishTokenLast4(token: string): string {
  return token.slice(-4);
}

type PublishTokenRow = typeof publishTokens.$inferSelect;

function toSummary(row: PublishTokenRow): PublishTokenSummary {
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
 * Exported as a plain function (not only a method) so environment creation can
 * mint INSIDE the transaction that creates the environment — an environment
 * that exists without a token would be one `hogsend publish` could never reach.
 */
export async function insertPublishToken(
  writer: CloudWriter,
  input: { environmentId: string },
): Promise<{ token: string; row: PublishTokenRow }> {
  const token = generatePublishToken();
  const [row] = await writer
    .insert(publishTokens)
    .values({
      environmentId: input.environmentId,
      tokenHash: hashPublishToken(token),
      last4: publishTokenLast4(token),
    })
    .onConflictDoUpdate({
      target: publishTokens.environmentId,
      set: {
        tokenHash: hashPublishToken(token),
        last4: publishTokenLast4(token),
        rotatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error(
      `Failed to issue a publish token for environment ${input.environmentId}`,
    );
  }
  return { token, row };
}

export class PublishTokenService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * Issue a token, replacing any existing one. The returned `token` is the only
   * copy that will ever exist outside the caller.
   */
  async mint(input: PublishTokenTargetInput): Promise<IssuePublishTokenResult> {
    const { environmentId, actor } = environmentInputSchema.parse(input);

    return this.db.transaction(async (tx) => {
      const organizationId = await lockEnvironmentOrganization(
        tx,
        environmentId,
      );
      const existing = await findByEnvironment(tx, environmentId);
      const { token, row } = await insertPublishToken(tx, { environmentId });

      await writeAudit(tx, {
        actor,
        organizationId,
        action: existing ? "publish_token.rotated" : "publish_token.minted",
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
   * promises the old credential stops working, and there is no old credential
   * to make that promise about — the caller wanted `mint`.
   */
  async rotate(
    input: PublishTokenTargetInput,
  ): Promise<IssuePublishTokenResult> {
    const { environmentId } = environmentInputSchema.parse(input);
    const existing = await findByEnvironment(this.db, environmentId);
    if (!existing) throw new NotFoundError("Publish token", environmentId);
    return this.mint(input);
  }

  /**
   * Guarantee this environment HAS a token, without issuing one anybody holds.
   *
   * The backfill for environments created before publish tokens existed. The
   * secret it generates is discarded on purpose: `ensure` is called from a page
   * read, and a secret that reached a render would be a secret shown more than
   * once. What it buys is that `rotate` — the only surface that hands a
   * customer a usable token — always has a row to replace, on every
   * environment, with no operator step.
   */
  async ensure(input: {
    environmentId: string;
  }): Promise<EnsurePublishTokenResult> {
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

      const { row } = await insertPublishToken(tx, { environmentId });
      await writeAudit(tx, {
        actor: "system",
        organizationId,
        action: "publish_token.minted",
        subject: row.id,
        detail: { environmentId, reason: "backfill" },
      });
      return { created: true, summary: toSummary(row) };
    });
  }

  /**
   * Which environment (if any) this token publishes to.
   *
   * The lookup is by HASH, so the plaintext is never compared against anything
   * and a database read can never surface a credential. The `timingSafeEqual`
   * below is the belt to that braces: the index lookup is what finds the row,
   * and this is what ACCEPTS it, so acceptance cannot be decided by a
   * short-circuiting `===` on attacker-influenced bytes.
   */
  async verify(input: { token: string }): Promise<VerifyPublishTokenResult> {
    const parsed = verifyInputSchema.safeParse(input);
    if (!parsed.success) return { found: false };

    const hash = hashPublishToken(parsed.data.token);
    const [row] = await this.db
      .select({
        id: publishTokens.id,
        environmentId: publishTokens.environmentId,
        tokenHash: publishTokens.tokenHash,
      })
      .from(publishTokens)
      .where(eq(publishTokens.tokenHash, hash))
      .limit(1);

    if (!row || !hashesMatch(hash, row.tokenHash)) return { found: false };
    return { found: true, environmentId: row.environmentId, tokenId: row.id };
  }

  /** The token metadata for one environment, or null. Never the secret. */
  async get(input: {
    environmentId: string;
  }): Promise<PublishTokenSummary | null> {
    const { environmentId } = environmentInputSchema.parse(input);
    const row = await findByEnvironment(this.db, environmentId);
    return row ? toSummary(row) : null;
  }
}

/** Length-safe constant-time comparison of two sha256 hex digests. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== TOKEN_HASH_LENGTH || b.length !== TOKEN_HASH_LENGTH) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

async function findByEnvironment(
  writer: CloudWriter,
  environmentId: string,
): Promise<PublishTokenRow | undefined> {
  const [row] = await writer
    .select()
    .from(publishTokens)
    .where(eq(publishTokens.environmentId, environmentId))
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

/** Default instance bound to the app pool — the usual import for callers. */
export const publishTokenService = new PublishTokenService();
