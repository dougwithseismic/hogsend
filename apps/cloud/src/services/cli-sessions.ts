import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cliSessions } from "../db/schema";
import { user } from "../db/schema/auth";
import { type CloudWriter, writeAudit } from "./audit";
import { NotFoundError } from "./errors";

/**
 * The credential `hogsend login` leaves on a machine, and the only module that
 * mints, checks or retires one.
 *
 * The laws, which are `publish-tokens.ts`'s laws plus one:
 *  - the secret is returned EXACTLY ONCE, by the call that issues it. Nothing
 *    stored is a token — only its sha256 — so no read can surface one;
 *  - acceptance is constant-time on the digest, so it cannot be decided by a
 *    short-circuiting compare over attacker-influenced bytes;
 *  - the audit trail records that a session moved, never any part of the
 *    token — not the hash, not `last4`;
 *  - and the new one: a session carries NO authority of its own. It names a
 *    user and an organization; what that user may DO is re-read from the
 *    membership at every use. A session cannot outlive the role that made it
 *    useful, which is why there is no scope column here to go stale.
 */

/** Every CLI token starts with this, so a leaked one is greppable in a log. */
export const CLI_TOKEN_PREFIX = "hscli_";

/** 32 bytes of CSPRNG entropy — 256 bits, the same floor as a publish token. */
const TOKEN_ENTROPY_BYTES = 32;

/** sha256 hex is 64 characters; anything else is not one of ours. */
const TOKEN_HASH_LENGTH = 64;

/**
 * How stale `last_used_at` may get before a use rewrites it.
 *
 * `hogsend publish` polls build status every few seconds, and a write per poll
 * would turn a read endpoint into a write amplifier on the busiest row in this
 * table. A minute of resolution is everything "when did this machine last
 * reach us" is ever asked to answer.
 */
export const CLI_SESSION_TOUCH_STALE_MS = 60_000;

const createInputSchema = z.object({
  userId: z.string().min(1).max(200),
  organizationId: z.string().min(1).max(200),
  label: z.string().min(1).max(128).optional(),
  actor: z.string().min(1).max(200).optional(),
});

const verifyInputSchema = z.object({
  // Bounded before it is hashed: an unbounded body must not become work.
  token: z.string().min(1).max(512),
});

export type CreateCliSessionInput = z.input<typeof createInputSchema>;

/** Everything a dashboard may see. Never the token, never the hash. */
export interface CliSessionSummary {
  id: string;
  userId: string;
  organizationId: string;
  label: string | null;
  last4: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** A summary plus the human it belongs to — what the Settings list renders. */
export interface CliSessionListItem extends CliSessionSummary {
  userEmail: string;
  userName: string;
}

export interface IssueCliSessionResult {
  /** The plaintext token. This is the ONLY time it exists outside a client. */
  token: string;
  summary: CliSessionSummary;
}

/**
 * Discriminated so "no such session" is an ordinary answer the caller must
 * handle rather than an exception it can forget to catch.
 *
 * A REVOKED session answers `found: false`, on purpose: every caller's correct
 * response to a revoked credential is the same as to an unknown one, and one
 * branch cannot be forgotten the way two can. That is the fail-closed half of
 * "a revoked session SHALL fail closed on next use".
 */
export type VerifyCliSessionResult =
  | { found: true; session: CliSessionSummary }
  | { found: false };

type CliSessionRow = typeof cliSessions.$inferSelect;

/** A fresh, never-before-issued CLI token. */
export function generateCliToken(): string {
  return `${CLI_TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
}

/** The one-way transform. The ONLY form of a token this app persists. */
export function hashCliToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/** Display tail: the last four characters of the secret body. */
export function cliTokenLast4(token: string): string {
  return token.slice(-4);
}

/** True for anything shaped like one of our CLI tokens. */
export function isCliToken(token: string): boolean {
  return token.startsWith(CLI_TOKEN_PREFIX);
}

function toSummary(row: CliSessionRow): CliSessionSummary {
  return {
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    label: row.label,
    last4: row.last4,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Insert a session on the caller's writer and return its plaintext token.
 *
 * Exported as a plain function so the device-code exchange can mint INSIDE the
 * transaction that consumes the code: a token handed out for a code that then
 * failed to commit would be a credential nothing recorded.
 */
export async function insertCliSession(
  writer: CloudWriter,
  input: { userId: string; organizationId: string; label?: string | null },
): Promise<{ token: string; row: CliSessionRow }> {
  const token = generateCliToken();
  const [row] = await writer
    .insert(cliSessions)
    .values({
      userId: input.userId,
      organizationId: input.organizationId,
      label: input.label ?? null,
      tokenHash: hashCliToken(token),
      last4: cliTokenLast4(token),
    })
    .returning();

  if (!row) {
    throw new Error(
      `Failed to issue a CLI session for user ${input.userId} in organization ${input.organizationId}`,
    );
  }
  return { token, row };
}

export class CliSessionService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * Issue a session. The returned `token` is the only copy that will ever
   * exist outside the caller.
   */
  async create(input: CreateCliSessionInput): Promise<IssueCliSessionResult> {
    const parsed = createInputSchema.parse(input);

    return this.db.transaction(async (tx) => {
      const { token, row } = await insertCliSession(tx, parsed);
      await writeAudit(tx, {
        actor: parsed.actor ?? parsed.userId,
        organizationId: parsed.organizationId,
        action: "cli_session.created",
        subject: row.id,
        // WHICH session, never WHAT it is: no hash, no last4.
        detail: { label: row.label, userId: row.userId },
      });
      return { token, summary: toSummary(row) };
    });
  }

  /**
   * Which session (if any) this token is. Revoked sessions answer `found:
   * false` — see {@link VerifyCliSessionResult}.
   *
   * The lookup is by HASH, so the plaintext is never compared against anything
   * and a database read can never surface a credential. `timingSafeEqual` is
   * the belt to that braces: the index finds the row, this ACCEPTS it.
   */
  async verify(input: { token: string }): Promise<VerifyCliSessionResult> {
    const parsed = verifyInputSchema.safeParse(input);
    if (!parsed.success) return { found: false };

    const hash = hashCliToken(parsed.data.token);
    const [row] = await this.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.tokenHash, hash))
      .limit(1);

    if (!row || !hashesMatch(hash, row.tokenHash)) return { found: false };
    if (row.revokedAt) return { found: false };
    return { found: true, session: toSummary(row) };
  }

  /**
   * Record that a session was used — at most once per
   * {@link CLI_SESSION_TOUCH_STALE_MS}.
   *
   * The staleness test is in the WHERE clause, not in a prior read: two
   * concurrent uses would otherwise both find the stamp old and both write.
   * Returns whether the stamp actually moved, which is what the throttle test
   * asserts on.
   */
  async touch(input: {
    sessionId: string;
    now?: Date;
    staleMs?: number;
  }): Promise<{ touched: boolean }> {
    const now = input.now ?? new Date();
    const staleMs = input.staleMs ?? CLI_SESSION_TOUCH_STALE_MS;
    const cutoff = new Date(now.getTime() - staleMs);

    const rows = await this.db
      .update(cliSessions)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(cliSessions.id, input.sessionId),
          isNull(cliSessions.revokedAt),
          or(
            isNull(cliSessions.lastUsedAt),
            lt(cliSessions.lastUsedAt, cutoff),
          ),
        ),
      )
      .returning({ id: cliSessions.id });

    return { touched: rows.length > 0 };
  }

  /**
   * The organization's LIVE sessions, newest first, with the human each one
   * belongs to. Revoked rows are kept in the table (an incident question) but
   * are not what "which machines can reach this org" means.
   */
  async list(input: {
    organizationId: string;
  }): Promise<{ sessions: CliSessionListItem[] }> {
    const { organizationId } = z
      .object({ organizationId: z.string().min(1) })
      .parse(input);

    const rows = await this.db
      .select({
        session: cliSessions,
        userEmail: user.email,
        userName: user.name,
      })
      .from(cliSessions)
      .innerJoin(user, eq(user.id, cliSessions.userId))
      .where(
        and(
          eq(cliSessions.organizationId, organizationId),
          isNull(cliSessions.revokedAt),
        ),
      )
      .orderBy(desc(cliSessions.createdAt), desc(cliSessions.id));

    return {
      sessions: rows.map((row) => ({
        ...toSummary(row.session),
        userEmail: row.userEmail,
        userName: row.userName,
      })),
    };
  }

  /** One session, scoped to an organization. Null when it is not theirs. */
  async get(input: {
    sessionId: string;
    organizationId?: string;
  }): Promise<CliSessionSummary | null> {
    const parsed = z
      .object({
        sessionId: z.uuid(),
        organizationId: z.string().min(1).optional(),
      })
      .safeParse(input);
    if (!parsed.success) return null;

    const [row] = await this.db
      .select()
      .from(cliSessions)
      .where(
        parsed.data.organizationId
          ? and(
              eq(cliSessions.id, parsed.data.sessionId),
              eq(cliSessions.organizationId, parsed.data.organizationId),
            )
          : eq(cliSessions.id, parsed.data.sessionId),
      )
      .limit(1);
    return row ? toSummary(row) : null;
  }

  /**
   * Retire a session. Scoped to an organization so a session id from another
   * tenant reads as "not found" rather than as a revocable row.
   *
   * The `revoked_at IS NULL` guard makes it idempotent in the way that matters:
   * a second revoke does not move the timestamp, so "when did this machine stop
   * being able to reach us" stays the first answer.
   */
  async revoke(input: {
    sessionId: string;
    organizationId: string;
    actor?: string;
  }): Promise<CliSessionSummary> {
    const parsed = z
      .object({
        sessionId: z.uuid(),
        organizationId: z.string().min(1),
        actor: z.string().min(1).max(200).optional(),
      })
      .parse(input);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(cliSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(cliSessions.id, parsed.sessionId),
            eq(cliSessions.organizationId, parsed.organizationId),
            isNull(cliSessions.revokedAt),
          ),
        )
        .returning();

      if (!row) {
        // Already revoked is not an error — it is the state the caller asked
        // for. A row that is not theirs, or does not exist, is.
        const [existing] = await tx
          .select()
          .from(cliSessions)
          .where(
            and(
              eq(cliSessions.id, parsed.sessionId),
              eq(cliSessions.organizationId, parsed.organizationId),
            ),
          )
          .limit(1);
        if (!existing) throw new NotFoundError("CLI session", parsed.sessionId);
        return toSummary(existing);
      }

      await writeAudit(tx, {
        actor: parsed.actor ?? "system",
        organizationId: parsed.organizationId,
        action: "cli_session.revoked",
        subject: row.id,
        detail: { label: row.label, userId: row.userId },
      });
      return toSummary(row);
    });
  }
}

/** Length-safe constant-time comparison of two sha256 hex digests. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== TOKEN_HASH_LENGTH || b.length !== TOKEN_HASH_LENGTH) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Default instance bound to the app pool — the usual import for callers. */
export const cliSessionService = new CliSessionService();
