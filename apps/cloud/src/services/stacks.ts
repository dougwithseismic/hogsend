import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { stacks } from "../db/schema";
import { type CloudWriter, writeAudit } from "./audit";
import { IllegalTransitionError, NotFoundError } from "./errors";
import type { StackRow } from "./orgs";

/**
 * The stack lifecycle — the state machine, and its only legal writer.
 *
 * The laws this module exists to hold (PRD 02 §"State machine is the law"):
 *  - `stacks.status` is written HERE and nowhere else. Every other service
 *    reads it; a provisioner that set it directly would skip both the legality
 *    check and the audit row, and the two must never come apart.
 *  - legality is a TABLE (`LEGAL_EDGES`), exported as data so PRD 04's
 *    reconciler can reason about reachability without re-deriving the rules.
 *  - legality is enforced by the WRITE, not by a prior read: every transition
 *    is an UPDATE carrying `WHERE status IN <legal sources>`, so an edge that
 *    is not legal updates zero rows no matter what any earlier SELECT said.
 *    Two provisioners racing the same edge serialise on the row lock and
 *    exactly one wins; the loser is told `IllegalTransitionError`.
 *  - a refused transition writes NOTHING: no status, no audit, no error
 *    message. The row is exactly as it was.
 */

export type StackStatus = StackRow["status"];

/**
 * The complete transition table, keyed by source status.
 *
 * Read the shape, not just the entries:
 *  - `requested → running` is absent on purpose. A stack becomes real only by
 *    passing THROUGH `provisioning`, so there is always a status that means
 *    "substrate work is in flight" and the reconciler can find it.
 *  - `running → destroying` is absent. Teardown of a live stack goes
 *    `running → suspended → destroying`: suspension is the reversible pause
 *    that gives a tenant (and an operator) a chance to stop.
 *  - `error → destroying` IS present, and is the exception that proves it. A
 *    stack that failed half-way through provisioning may never have run, so
 *    demanding it suspend first would strand real substrate behind a status it
 *    can never reach.
 *  - `destroyed` has no outgoing edges at all. It is the one terminal state;
 *    a new stack is a new row.
 */
export const LEGAL_EDGES = {
  requested: ["provisioning"],
  provisioning: ["running", "error"],
  running: ["publishing", "suspended"],
  publishing: ["running", "error"],
  suspended: ["running", "destroying"],
  destroying: ["destroyed", "error"],
  destroyed: [],
  error: ["provisioning", "suspended", "destroying"],
} as const satisfies Record<StackStatus, readonly StackStatus[]>;

/**
 * Every status from which `to` is reachable — the table read backwards, which
 * is the direction a guarded UPDATE needs it.
 */
export function legalSources(to: StackStatus): StackStatus[] {
  return (Object.keys(LEGAL_EDGES) as StackStatus[]).filter((from) =>
    (LEGAL_EDGES[from] as readonly StackStatus[]).includes(to),
  );
}

function isLegalEdge(from: StackStatus, to: StackStatus): boolean {
  return (LEGAL_EDGES[from] as readonly StackStatus[]).includes(to);
}

/** The statuses that mean "substrate work is in flight" — the only ones that
 * can fail. A `running` stack does not "error"; it publishes or suspends. */
const FAILABLE_STATUSES = legalSources("error");

/** `last_error` is an operator hint, not a log. Postgres would take megabytes;
 * a stack trace that size makes the dashboard useless and the row expensive. */
const MAX_LAST_ERROR_LENGTH = 2000;

const statusSchema = z.enum([
  "requested",
  "provisioning",
  "running",
  "publishing",
  "suspended",
  "destroying",
  "destroyed",
  "error",
]);

const actorSchema = z.string().min(1).max(200);

const transitionInputSchema = z.object({
  stackId: z.uuid(),
  to: statusSchema,
  /**
   * Optional optimistic guard: "I believe it is HERE". Narrows the UPDATE from
   * "any legal source" to exactly one, so a caller resuming stale work fails
   * loudly instead of re-driving an edge someone else already took.
   */
  expectedFrom: statusSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  actor: actorSchema.optional(),
});

const recordErrorInputSchema = z.object({
  stackId: z.uuid(),
  error: z.union([z.string(), z.instanceof(Error)]),
  /** Which provisioning step failed, for the audit trail. */
  step: z.string().max(200).optional(),
  actor: actorSchema.optional(),
});

const getInputSchema = z.object({ stackId: z.uuid() });
const byEnvironmentInputSchema = z.object({ environmentId: z.uuid() });

export type TransitionInput = z.input<typeof transitionInputSchema>;
export type RecordErrorInput = z.input<typeof recordErrorInputSchema>;

export class StackService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * Move a stack to `to`, or refuse. The ONLY writer of `stacks.status`.
   *
   * Side effects that ride along with the status, deliberately in the same
   * statement so they cannot drift from it:
   *  - leaving `error` clears `last_error` (the message described the attempt
   *    we just left; keeping it would make a healthy stack look broken);
   *  - reaching `running` resets `retry_count` — it counts attempts since the
   *    last SUCCESS, and this is one.
   */
  async transition(input: TransitionInput): Promise<StackRow> {
    const { stackId, to, expectedFrom, detail, actor } =
      transitionInputSchema.parse(input);

    // An `expectedFrom` the table forbids can never succeed; refuse it without
    // touching the database, and report the edge the caller actually asked for.
    if (expectedFrom && !isLegalEdge(expectedFrom, to)) {
      throw new IllegalTransitionError(stackId, expectedFrom, to);
    }
    const sources = expectedFrom ? [expectedFrom] : legalSources(to);

    return this.db.transaction(async (tx) => {
      const from = await lockStatus(tx, stackId);
      const row = await applyStatus(tx, {
        stackId,
        sources,
        set: {
          status: to,
          // The message described the attempt we are leaving; a healthy stack
          // must not carry a stale reason for a failure it recovered from.
          ...(from === "error" ? { lastError: null } : {}),
          // `retry_count` counts attempts since the last SUCCESS — and this
          // is one.
          ...(to === "running" ? { retryCount: 0 } : {}),
        },
      });
      if (!row) throw new IllegalTransitionError(stackId, from, to);

      await writeAudit(tx, {
        actor,
        organizationId: row.organizationId,
        action: "stack.transition",
        subject: stackId,
        detail: { ...(detail ?? {}), from, to },
      });

      return row;
    });
  }

  /**
   * Park a stack in `error` with the reason. Separate from `transition` because
   * it carries two more writes that must land atomically with the status: the
   * message and the attempt count.
   */
  async recordError(input: RecordErrorInput): Promise<StackRow> {
    const { stackId, error, step, actor } = recordErrorInputSchema.parse(input);
    const message = (error instanceof Error ? error.message : error).slice(
      0,
      MAX_LAST_ERROR_LENGTH,
    );

    return this.db.transaction(async (tx) => {
      const from = await lockStatus(tx, stackId);
      const row = await applyStatus(tx, {
        stackId,
        sources: FAILABLE_STATUSES,
        set: {
          status: "error",
          lastError: message,
          retryCount: sql`${stacks.retryCount} + 1`,
        },
      });
      if (!row) throw new IllegalTransitionError(stackId, from, "error");

      await writeAudit(tx, {
        actor,
        organizationId: row.organizationId,
        action: "stack.error",
        subject: stackId,
        detail: { from, to: "error", step, error: message },
      });

      return row;
    });
  }

  async get(input: { stackId: string }): Promise<StackRow | null> {
    const { stackId } = getInputSchema.parse(input);
    const [row] = await this.db
      .select()
      .from(stacks)
      .where(eq(stacks.id, stackId))
      .limit(1);
    return row ?? null;
  }

  /** The 1:1 partner lookup — the provisioner's entry point from an
   * environment id. */
  async getByEnvironment(input: {
    environmentId: string;
  }): Promise<StackRow | null> {
    const { environmentId } = byEnvironmentInputSchema.parse(input);
    const [row] = await this.db
      .select()
      .from(stacks)
      .where(eq(stacks.environmentId, environmentId))
      .limit(1);
    return row ?? null;
  }
}

/**
 * Lock the row and read the status it is in RIGHT NOW. Refuses nothing — that
 * is the UPDATE's job.
 *
 * This read exists for one reason: Postgres RETURNING reports the row AFTER the
 * update, so a single statement cannot tell us where the stack came from, and
 * the audit must record the status that actually WAS rather than the one the
 * caller assumed. `FOR UPDATE` makes the answer exact: a racing transition
 * blocks here, then (READ COMMITTED) re-reads the winner's committed row, so it
 * names the NEW status and its own guarded UPDATE then matches nothing.
 */
async function lockStatus(
  writer: CloudWriter,
  stackId: string,
): Promise<StackStatus> {
  const [current] = await writer
    .select({ status: stacks.status })
    .from(stacks)
    .where(eq(stacks.id, stackId))
    .limit(1)
    .for("update");
  if (!current) throw new NotFoundError("Stack", stackId);
  return current.status;
}

/**
 * The one guarded write, and the sole enforcement point: `WHERE status IN
 * <legal sources>` means an illegal edge updates zero rows whatever any earlier
 * read believed. Returns null in that case.
 */
async function applyStatus(
  writer: CloudWriter,
  args: {
    stackId: string;
    sources: StackStatus[];
    set: PgUpdateSetSource<typeof stacks>;
  },
): Promise<StackRow | null> {
  // Nothing reaches a status with no legal source (`requested`, `destroyed`),
  // and an empty IN-list is not a query worth building.
  if (args.sources.length === 0) return null;

  const [row] = await writer
    .update(stacks)
    .set(args.set)
    .where(
      and(eq(stacks.id, args.stackId), inArray(stacks.status, args.sources)),
    )
    .returning();
  return row ?? null;
}

/** Default instance bound to the app pool — the usual import for callers. */
export const stackService = new StackService();
