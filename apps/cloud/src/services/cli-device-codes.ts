import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cliDeviceCodes } from "../db/schema";
import {
  USER_CODE_ALPHABET,
  USER_CODE_GROUP,
  USER_CODE_GROUPS,
} from "../lib/user-code-shape";
import { writeAudit } from "./audit";
import { insertCliSession } from "./cli-sessions";
import { isUniqueViolation } from "./errors";

/**
 * The device-code flow behind `hogsend login`.
 *
 * Two codes, with deliberately different powers:
 *
 *  - the **device code** (`hscd_…`, 256 bits) is a secret only the CLI ever
 *    holds. It is stored hashed, it is what polling authenticates with, and it
 *    is the ONLY thing that can turn an approval into a token;
 *  - the **user code** (`XXXX-XXXX`) is short enough to read aloud, so it is
 *    built to be powerless. Quoting one approves nothing: approval is a
 *    mutation performed by a SIGNED-IN dashboard user, and the user code only
 *    names which pending request they are approving. Guessing one therefore
 *    buys an attacker the ability to approve their own session into their own
 *    organization — which is what `hogsend login` does anyway.
 *
 * The token is minted at EXCHANGE, never at approval. That is what keeps the
 * plaintext to exactly one HTTP response and out of the database entirely:
 * `consumed_at` is a single-use latch set by a guarded UPDATE, so the poll that
 * wins is the only one that ever sees a credential.
 *
 * Every expiry test is done in SQL against a passed-in instant rather than
 * against a value read earlier, so a code cannot be approved in the gap between
 * "is it still live?" and the write that acts on the answer.
 */

/** Every device code starts with this, so a leaked one is greppable. */
export const DEVICE_CODE_PREFIX = "hscd_";

/** 32 bytes of CSPRNG entropy — the poll secret is a credential. */
const DEVICE_CODE_ENTROPY_BYTES = 32;

/**
 * How long a login attempt stays open. Comfortably under the 15-minute ceiling
 * the PRD sets, and the same order as the sign-in OTP: a human who walked away
 * mid-login should have to start again rather than leave a live approval
 * lying about.
 */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;

/** What the CLI is told to wait between polls. */
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;

/**
 * How long a LAPSED device code is kept before {@link CliDeviceCodeService.reap}
 * deletes it.
 *
 * These rows are garbage the moment they expire — nothing reads a code past its
 * expiry, and the lazy `status = 'expired'` writes only keep the vocabulary
 * honest, they free nothing. The row is kept a day past expiry anyway so an
 * operator looking at a login that went wrong this morning still finds it; the
 * durable record of an approval is the AUDIT LOG, which carries the device code
 * id and outlives the row.
 *
 * Without this the table grows forever on an UNAUTHENTICATED endpoint: every
 * accepted mint is a permanent row in the control-plane database.
 */
export const DEVICE_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Rows deleted per reap. Bounded because the reap runs on a request path: a
 * backlog is cleared over several passes rather than in one long statement.
 */
export const DEVICE_CODE_REAP_BATCH = 500;

// The alphabet and shape live in `../lib/user-code-shape` — a PURE module,
// because the approve page's client-side code boxes need them and this file
// drags the database into any bundle that imports it. One definition, re-
// exported here so existing importers keep working.
export { USER_CODE_ALPHABET, USER_CODE_GROUP, USER_CODE_GROUPS };

/** How many collisions the generator will absorb before giving up. */
const USER_CODE_ATTEMPTS = 8;

const mintInputSchema = z.object({
  label: z.string().min(1).max(128).optional(),
  now: z.date().optional(),
});

export type MintDeviceCodeInput = z.input<typeof mintInputSchema>;

export interface MintDeviceCodeResult {
  /** The poll secret. Returned once, to the CLI, and stored only hashed. */
  deviceCode: string;
  /** The short code a human types into the dashboard. */
  userCode: string;
  expiresAt: Date;
  /** Seconds the CLI should wait between polls. */
  interval: number;
}

/** What the approve page renders about a pending request. Nothing secret. */
export interface DeviceCodeRequest {
  id: string;
  userCode: string;
  label: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Why an approve/deny could not be applied. A rule the page can print, not an
 * exception — every one of these is something a human can act on.
 */
export type DeviceCodeDecisionResult =
  | { ok: true; request: DeviceCodeRequest }
  | { ok: false; reason: "not_found" | "expired" | "already_resolved" };

/**
 * The poll answer. `expired` is the catch-all stonewall: an unknown code, a
 * lapsed one, and an approval that was ALREADY exchanged all answer the same
 * way, because distinguishing them would turn the poll endpoint into an oracle
 * about codes the caller does not hold.
 */
export type DeviceCodePollResult =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | {
      status: "approved";
      /** The ONLY copy of the CLI token that will ever exist outside a client. */
      token: string;
      sessionId: string;
      organizationId: string;
      userId: string;
    };

/** A fresh device code. */
export function generateDeviceCode(): string {
  return `${DEVICE_CODE_PREFIX}${randomBytes(DEVICE_CODE_ENTROPY_BYTES).toString("base64url")}`;
}

/** The one-way transform. The ONLY form of a device code this app persists. */
export function hashDeviceCode(deviceCode: string): string {
  return createHash("sha256").update(deviceCode, "utf-8").digest("hex");
}

/**
 * A user code from {@link USER_CODE_ALPHABET}.
 *
 * `randomInt` is a rejection-sampling CSPRNG draw, not `random() * n`: a modulo
 * bias here would shrink the code space in a way nothing downstream would ever
 * notice.
 */
export function generateUserCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < USER_CODE_GROUPS; group += 1) {
    let chars = "";
    for (let index = 0; index < USER_CODE_GROUP; index += 1) {
      chars += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    }
    groups.push(chars);
  }
  return groups.join("-");
}

/**
 * Accept a user code however a human typed it: any case, with or without the
 * hyphen, with stray spaces. Anything outside the alphabet is refused rather
 * than stripped, so a typo stays a typo instead of silently becoming a
 * DIFFERENT valid code.
 */
export function normalizeUserCode(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
  if (cleaned.length !== USER_CODE_GROUP * USER_CODE_GROUPS) return null;
  for (const char of cleaned) {
    if (!USER_CODE_ALPHABET.includes(char)) return null;
  }
  const groups: string[] = [];
  for (let at = 0; at < cleaned.length; at += USER_CODE_GROUP) {
    groups.push(cleaned.slice(at, at + USER_CODE_GROUP));
  }
  return groups.join("-");
}

type DeviceCodeRow = typeof cliDeviceCodes.$inferSelect;

function toRequest(row: DeviceCodeRow): DeviceCodeRequest {
  return {
    id: row.id,
    userCode: row.userCode,
    label: row.label,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export class CliDeviceCodeService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /** Open a login attempt. Returns the two codes; stores only the hash. */
  async mint(input: MintDeviceCodeInput = {}): Promise<MintDeviceCodeResult> {
    const parsed = mintInputSchema.parse(input);
    const now = parsed.now ?? new Date();
    const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
    const deviceCode = generateDeviceCode();

    // The unique index is what decides a collision, not a prior read: two
    // mints racing the same draw must not both take it.
    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
      const userCode = generateUserCode();
      try {
        const [row] = await this.db
          .insert(cliDeviceCodes)
          .values({
            deviceCodeHash: hashDeviceCode(deviceCode),
            userCode,
            label: parsed.label ?? null,
            status: "pending",
            expiresAt,
          })
          .returning({ userCode: cliDeviceCodes.userCode });
        if (!row) throw new Error("Failed to open a CLI login attempt");
        return {
          deviceCode,
          userCode: row.userCode,
          expiresAt,
          interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
        };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error(
      "Failed to allocate a unique CLI login code; try again shortly",
    );
  }

  /**
   * Delete device codes that lapsed more than {@link DEVICE_CODE_RETENTION_MS}
   * ago. The table's reaper — the thing the `expires_at` index exists for.
   *
   * Status is irrelevant: pending, denied, approved-and-consumed are all
   * garbage once the code is a day past its expiry, and the audit log is what
   * remembers that an approval happened. Bounded per pass, and driven from the
   * mint route's window-open path, so the sweep happens exactly when rows are
   * being created and never when they are not.
   */
  async reap(
    input: { now?: Date; retentionMs?: number; limit?: number } = {},
  ): Promise<{ deleted: number }> {
    const now = input.now ?? new Date();
    const cutoff = new Date(
      now.getTime() - (input.retentionMs ?? DEVICE_CODE_RETENTION_MS),
    );

    const doomed = this.db
      .select({ id: cliDeviceCodes.id })
      .from(cliDeviceCodes)
      .where(lt(cliDeviceCodes.expiresAt, cutoff))
      .limit(input.limit ?? DEVICE_CODE_REAP_BATCH);

    const deleted = await this.db
      .delete(cliDeviceCodes)
      .where(inArray(cliDeviceCodes.id, doomed))
      .returning({ id: cliDeviceCodes.id });

    return { deleted: deleted.length };
  }

  /**
   * The pending request behind a user code, for the approve page to render.
   *
   * Callable only by a signed-in dashboard user (the ops layer enforces that),
   * and it returns nothing secret — a label the CLI chose and two timestamps.
   */
  async describe(input: {
    userCode: string;
    now?: Date;
  }): Promise<DeviceCodeRequest | null> {
    const userCode = normalizeUserCode(input.userCode);
    if (!userCode) return null;
    const now = input.now ?? new Date();

    const [row] = await this.db
      .select()
      .from(cliDeviceCodes)
      .where(eq(cliDeviceCodes.userCode, userCode))
      .limit(1);

    if (!row) return null;
    if (row.status !== "pending" || row.expiresAt <= now) return null;
    return toRequest(row);
  }

  /**
   * Bind a pending request to this user and organization.
   *
   * One guarded UPDATE: the status, the expiry and the write happen in the same
   * statement, so a code cannot be approved twice and cannot be approved in the
   * moment after it lapsed. No token is minted here — see the module note.
   */
  async approve(input: {
    userCode: string;
    userId: string;
    organizationId: string;
    now?: Date;
    actor?: string;
  }): Promise<DeviceCodeDecisionResult> {
    return this.decide({ ...input, to: "approved" });
  }

  /** Refuse a pending request. The CLI's next poll gets `denied` and stops. */
  async deny(input: {
    userCode: string;
    userId: string;
    organizationId: string;
    now?: Date;
    actor?: string;
  }): Promise<DeviceCodeDecisionResult> {
    return this.decide({ ...input, to: "denied" });
  }

  private async decide(input: {
    userCode: string;
    userId: string;
    organizationId: string;
    to: "approved" | "denied";
    now?: Date;
    actor?: string;
  }): Promise<DeviceCodeDecisionResult> {
    const userCode = normalizeUserCode(input.userCode);
    if (!userCode) return { ok: false, reason: "not_found" };
    const now = input.now ?? new Date();

    return this.db.transaction(async (tx) => {
      // `FOR UPDATE` is what makes the read-then-write below safe: two
      // dashboard tabs pressing Approve at once serialise here, and the second
      // one re-reads a row that is no longer `pending`.
      const [row] = await tx
        .select()
        .from(cliDeviceCodes)
        .where(eq(cliDeviceCodes.userCode, userCode))
        .limit(1)
        .for("update");

      if (!row) return { ok: false as const, reason: "not_found" as const };

      if (row.status === "expired" || row.expiresAt <= now) {
        if (row.status === "pending") {
          // Lazy reaping: the vocabulary in the column stays true without a
          // sweep nobody would otherwise need.
          await tx
            .update(cliDeviceCodes)
            .set({ status: "expired", updatedAt: now })
            .where(eq(cliDeviceCodes.id, row.id));
        }
        return { ok: false as const, reason: "expired" as const };
      }

      if (row.status !== "pending") {
        return { ok: false as const, reason: "already_resolved" as const };
      }

      const [decided] = await tx
        .update(cliDeviceCodes)
        .set({
          status: input.to,
          organizationId: input.organizationId,
          approvedByUserId: input.userId,
          updatedAt: now,
        })
        .where(eq(cliDeviceCodes.id, row.id))
        .returning();
      if (!decided) {
        return { ok: false as const, reason: "not_found" as const };
      }

      await writeAudit(tx, {
        actor: input.actor ?? input.userId,
        organizationId: input.organizationId,
        action:
          input.to === "approved" ? "cli_device.approved" : "cli_device.denied",
        subject: decided.id,
        // The user code names WHICH request; it is not a credential, and the
        // device code (which is) never appears here.
        detail: { userCode: decided.userCode, label: decided.label },
      });

      return { ok: true as const, request: toRequest(decided) };
    });
  }

  /**
   * The CLI's poll. Returns the token exactly once, for the first caller that
   * wins the `consumed_at` latch.
   */
  async poll(input: {
    deviceCode: string;
    now?: Date;
  }): Promise<DeviceCodePollResult> {
    const parsed = z
      .object({ deviceCode: z.string().min(1).max(512) })
      .safeParse({ deviceCode: input.deviceCode });
    if (!parsed.success) return { status: "expired" };

    const now = input.now ?? new Date();
    const hash = hashDeviceCode(parsed.data.deviceCode);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(cliDeviceCodes)
        .where(eq(cliDeviceCodes.deviceCodeHash, hash))
        .limit(1)
        .for("update");

      // An unknown code and a lapsed one are the same answer on purpose.
      if (!row) return { status: "expired" as const };

      if (row.status === "denied") return { status: "denied" as const };

      if (row.expiresAt <= now || row.status === "expired") {
        if (row.status === "pending") {
          // Lazy reaping: the vocabulary in the column stays true without a
          // sweep nobody would otherwise need.
          await tx
            .update(cliDeviceCodes)
            .set({ status: "expired", updatedAt: now })
            .where(eq(cliDeviceCodes.id, row.id));
        }
        return { status: "expired" as const };
      }

      if (row.status === "pending") return { status: "pending" as const };

      // Approved. Everything below happens at most once per row.
      if (!row.organizationId || !row.approvedByUserId) {
        throw new Error(
          `CLI device code ${row.id} is approved without an approver`,
        );
      }

      const [claimed] = await tx
        .update(cliDeviceCodes)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(cliDeviceCodes.id, row.id),
            eq(cliDeviceCodes.status, "approved"),
            isNull(cliDeviceCodes.consumedAt),
          ),
        )
        .returning({ id: cliDeviceCodes.id });

      // Already exchanged: the machine that holds the token got it, and this
      // caller gets the same stonewall as an unknown code.
      if (!claimed) return { status: "expired" as const };

      const { token, row: session } = await insertCliSession(tx, {
        userId: row.approvedByUserId,
        organizationId: row.organizationId,
        label: row.label,
      });

      await tx
        .update(cliDeviceCodes)
        .set({ approvedSessionId: session.id })
        .where(eq(cliDeviceCodes.id, row.id));

      await writeAudit(tx, {
        actor: row.approvedByUserId,
        organizationId: row.organizationId,
        action: "cli_session.created",
        subject: session.id,
        detail: {
          label: session.label,
          userId: session.userId,
          deviceCodeId: row.id,
        },
      });

      return {
        status: "approved" as const,
        token,
        sessionId: session.id,
        organizationId: session.organizationId,
        userId: session.userId,
      };
    });
  }
}

/** Default instance bound to the app pool — the usual import for callers. */
export const cliDeviceCodeService = new CliDeviceCodeService();
