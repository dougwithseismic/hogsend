import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { builds, environments } from "../db/schema";
import { getArtifactStore } from "../lib/artifacts";
import { type CloudWriter, writeAudit } from "./audit";
import {
  BuildInFlightError,
  BuildQueueFullError,
  IllegalBuildTransitionError,
  isUniqueViolation,
  NotFoundError,
} from "./errors";

/**
 * The build lifecycle — the state machine, and its only legal writer.
 *
 * Deliberately the same shape as `StackService` (PRD 02), for the same reasons:
 *  - `builds.status` is written HERE and nowhere else, so the legal-edge table
 *    and the audit row cannot come apart;
 *  - legality is a TABLE (`LEGAL_BUILD_EDGES`), exported as data so the build
 *    task can reason about the pipeline without re-deriving it;
 *  - legality is enforced by the WRITE (`WHERE status IN <legal sources>`), not
 *    by a prior read, so two workers racing an edge serialise on the row lock
 *    and exactly one wins;
 *  - a refused transition writes NOTHING.
 *
 * The one law that is NOT here is single-flight. "Never two builds racing one
 * stack" (PRD 08) is a partial unique index in Postgres
 * (`builds_environment_running_unique_idx`), not a check in this file: a check
 * would be a read-then-write that two control-plane replicas can both pass.
 * That index covers the RUNNING statuses only, which is what makes the other
 * half of the same PRD line — "a second publish to a busy environment SHALL
 * queue, never race" — expressible at all: publishes accumulate as `queued`
 * rows, and the race is refused at the moment one of them tries to START.
 */

/** The pipeline's vocabulary, in the order a healthy build walks it. */
export const BUILD_STATUSES = [
  "queued",
  "building",
  "preflight",
  "pushing",
  "deploying",
  "succeeded",
  "failed",
] as const;

export type BuildStatus = (typeof BUILD_STATUSES)[number];

/**
 * The complete transition table, keyed by source status.
 *
 * Read the shape, not just the entries:
 *  - it is a LINE, not a graph: every stage has exactly one successor, because
 *    a build has no branches — it is unpack → build → preflight → push →
 *    deploy;
 *  - every non-terminal stage can reach `failed`. A build is the one thing here
 *    that fails at any point (a bad Dockerfile, a preflight refusal, a registry
 *    outage), and each of those must be able to park the record;
 *  - `succeeded` and `failed` have no outgoing edges. A build is a record of
 *    ONE attempt; a retry is a new build, with its own artifact and its own log.
 *    This is also what makes the single-flight index safe: the two statuses its
 *    predicate excludes are exactly the two nothing can leave.
 */
export const LEGAL_BUILD_EDGES = {
  queued: ["building", "failed"],
  building: ["preflight", "failed"],
  preflight: ["pushing", "failed"],
  pushing: ["deploying", "failed"],
  deploying: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
} as const satisfies Record<BuildStatus, readonly BuildStatus[]>;

/**
 * The statuses a build never leaves. Together with `queued` they are, word for
 * word, the predicate of `builds_environment_running_unique_idx`. A status
 * added here without the matching migration would silently widen what
 * single-flight allows, so the suite asserts the two agree behaviourally
 * (`builds.test.ts`).
 */
export const TERMINAL_BUILD_STATUSES = ["succeeded", "failed"] as const;

/** Everything that is not finished: a build running, or one still waiting. */
export const ACTIVE_BUILD_STATUSES = BUILD_STATUSES.filter(
  (status) =>
    !(TERMINAL_BUILD_STATUSES as readonly BuildStatus[]).includes(status),
);

/**
 * The statuses the single-flight index forbids twice per environment: work
 * actually in progress. `queued` is deliberately absent — a queue of waiting
 * publishes is the point.
 */
export const RUNNING_BUILD_STATUSES = ACTIVE_BUILD_STATUSES.filter(
  (status) => status !== "queued",
);

/**
 * How many publishes may WAIT for one environment, on top of the one running.
 *
 * A cap rather than an unbounded queue because every waiting build pins a
 * tarball of tenant source on a shared build host, and the queue drains one
 * build at a time. Small on purpose: the queue exists so a publish that raced a
 * build is not lost, not so a CI loop can buffer a morning's worth of pushes.
 */
export const MAX_QUEUED_BUILDS_PER_ENVIRONMENT = 3;

export function isTerminalBuildStatus(status: BuildStatus): boolean {
  return (TERMINAL_BUILD_STATUSES as readonly BuildStatus[]).includes(status);
}

/** Every status from which `to` is reachable — the table read backwards. */
export function legalBuildSources(to: BuildStatus): BuildStatus[] {
  return BUILD_STATUSES.filter((from) =>
    (LEGAL_BUILD_EDGES[from] as readonly BuildStatus[]).includes(to),
  );
}

function isLegalBuildEdge(from: BuildStatus, to: BuildStatus): boolean {
  return (LEGAL_BUILD_EDGES[from] as readonly BuildStatus[]).includes(to);
}

/**
 * The log tail's ceiling, in characters. Docker output is unbounded and mostly
 * layer chatter; the tail is what a failure diagnosis reads. Enforced in the
 * UPDATE itself so no caller can forget it.
 */
export const MAX_LOG_TAIL_CHARS = 65_536;

/** `error` is an operator hint, not a log — the tail already holds the log. */
const MAX_ERROR_LENGTH = 2000;

/** One append must not be able to exceed the tail it is appended to. */
const MAX_LOG_CHUNK_CHARS = MAX_LOG_TAIL_CHARS;

const statusSchema = z.enum(BUILD_STATUSES);
const actorSchema = z.string().min(1).max(200);

const createInputSchema = z.object({
  environmentId: z.uuid(),
  /**
   * Supplied by the intake route, which needs the id BEFORE the insert: the
   * artifact is written to a path derived from it, so a build that fails to
   * insert leaves no file behind under an id nothing references.
   */
  id: z.uuid().optional(),
  stackId: z.uuid().optional(),
  artifactPath: z.string().min(1).max(512),
  manifest: z.record(z.string(), z.unknown()).default({}),
  engineVersion: z.string().min(1).max(64).optional(),
  actor: actorSchema.optional(),
});

const transitionInputSchema = z.object({
  buildId: z.uuid(),
  to: statusSchema,
  /** Optimistic guard: narrows the UPDATE from "any legal source" to one. */
  expectedFrom: statusSchema.optional(),
  /** Recorded with the `failed` transition; ignored on any other edge. */
  error: z.union([z.string(), z.instanceof(Error)]).optional(),
  imageDigest: z.string().min(1).max(256).optional(),
  engineVersion: z.string().min(1).max(64).optional(),
  stackId: z.uuid().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  actor: actorSchema.optional(),
});

const appendLogInputSchema = z.object({
  buildId: z.uuid(),
  chunk: z.string().min(1).max(MAX_LOG_CHUNK_CHARS),
});

const getInputSchema = z.object({
  buildId: z.uuid(),
  /** Tenancy scope: a build read through an environment the caller owns. */
  environmentId: z.uuid().optional(),
});

const listInputSchema = z.object({
  environmentId: z.uuid(),
  limit: z.number().int().min(1).max(200).default(20),
});

export type CreateBuildInput = z.input<typeof createInputSchema>;
export type TransitionBuildInput = z.input<typeof transitionInputSchema>;
export type AppendBuildLogInput = z.input<typeof appendLogInputSchema>;

export type BuildRow = typeof builds.$inferSelect;

/** The build-history row — everything the list renders, and no log. */
export interface BuildSummary {
  id: string;
  environmentId: string;
  status: BuildStatus;
  engineVersion: string | null;
  imageDigest: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export type ListBuildsResult = { builds: BuildSummary[] };

export function toBuildSummary(row: BuildRow): BuildSummary {
  return {
    id: row.id,
    environmentId: row.environmentId,
    status: row.status,
    engineVersion: row.engineVersion,
    imageDigest: row.imageDigest,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export class BuildService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * QUEUE a build for an uploaded artifact. Never refuses because another build
   * is running — that is exactly the case the queue exists for (PRD 08: "a
   * second publish to a busy environment SHALL queue, never race").
   *
   * The one refusal is depth: past {@link MAX_QUEUED_BUILDS_PER_ENVIRONMENT}
   * waiting builds the environment is told to publish again later
   * (`BuildQueueFullError`). That check is a read followed by a write, so it is
   * serialised per environment by a transaction-scoped ADVISORY LOCK — without
   * it two control-plane replicas could each read "2 waiting" and both insert.
   * The lock is per environment id, so publishes to different environments
   * never wait on each other.
   */
  async create(input: CreateBuildInput): Promise<BuildRow> {
    const parsed = createInputSchema.parse(input);
    const id = parsed.id ?? randomUUID();

    return await this.db.transaction(async (tx) => {
      const organizationId = await readOrganizationId(tx, parsed.environmentId);

      // Held until this transaction ends, so the count below and the insert
      // that acts on it cannot be interleaved by another publish.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${parsed.environmentId}, 0))`,
      );

      const [waiting] = await tx
        .select({ queued: sql<number>`count(*)::int` })
        .from(builds)
        .where(
          and(
            eq(builds.environmentId, parsed.environmentId),
            eq(builds.status, "queued"),
          ),
        );
      if ((waiting?.queued ?? 0) >= MAX_QUEUED_BUILDS_PER_ENVIRONMENT) {
        throw new BuildQueueFullError(
          parsed.environmentId,
          MAX_QUEUED_BUILDS_PER_ENVIRONMENT,
        );
      }

      const [row] = await tx
        .insert(builds)
        .values({
          id,
          environmentId: parsed.environmentId,
          ...(parsed.stackId ? { stackId: parsed.stackId } : {}),
          status: "queued",
          artifactPath: parsed.artifactPath,
          manifest: parsed.manifest,
          ...(parsed.engineVersion
            ? { engineVersion: parsed.engineVersion }
            : {}),
        })
        .returning();
      if (!row) {
        throw new Error(
          `Failed to create a build for environment ${parsed.environmentId}`,
        );
      }

      await writeAudit(tx, {
        actor: parsed.actor,
        organizationId,
        action: "build.created",
        subject: row.id,
        detail: {
          environmentId: parsed.environmentId,
          engineVersion: parsed.engineVersion ?? null,
        },
      });

      return row;
    });
  }

  /**
   * Move a build to `to`, or refuse. The ONLY writer of `builds.status`.
   *
   * Side effects ride along in the SAME statement so they cannot drift from the
   * status they describe:
   *  - leaving `queued` stamps `started_at` (a build's duration is measured
   *    from when work began, not from when the tarball landed);
   *  - reaching a terminal status stamps `finished_at`;
   *  - `failed` carries the reason; every other edge CLEARS it, so a build that
   *    was re-driven past a stage cannot keep a stale explanation.
   *
   * Two things happen at the edges of the machine rather than inside a stage:
   *  - LEAVING `queued` is the claim. It is the write the single-flight index
   *    watches, so a worker that lost the race for a busy environment gets
   *    `BuildInFlightError` here and its build simply stays queued;
   *  - REACHING a terminal status retires the uploaded tarball. A finished
   *    build never needs its artifact again (the log tail is the diagnosis
   *    surface), and a control plane that kept every tenant's source forever
   *    would be both a disk bug and a data-retention one.
   */
  async transition(input: TransitionBuildInput): Promise<BuildRow> {
    const parsed = transitionInputSchema.parse(input);
    const { buildId, to, expectedFrom } = parsed;

    // An `expectedFrom` the table forbids can never succeed; refuse it without
    // touching the database, naming the edge the caller actually asked for.
    if (expectedFrom && !isLegalBuildEdge(expectedFrom, to)) {
      throw new IllegalBuildTransitionError(buildId, expectedFrom, to);
    }
    const sources = expectedFrom ? [expectedFrom] : legalBuildSources(to);

    const now = new Date();
    const message =
      parsed.error === undefined
        ? null
        : (parsed.error instanceof Error
            ? parsed.error.message
            : parsed.error
          ).slice(0, MAX_ERROR_LENGTH);

    const updated = await this.db.transaction(async (tx) => {
      const locked = await lockBuildStatus(tx, buildId);
      const from = locked.status;
      const row = await applyBuildStatus(tx, {
        buildId,
        sources,
        environmentId: locked.environmentId,
        set: {
          status: to,
          updatedAt: now,
          // Work has begun; the queue wait is over.
          ...(from === "queued" && to !== "failed" ? { startedAt: now } : {}),
          ...(isTerminalBuildStatus(to) ? { finishedAt: now } : {}),
          // The reason belongs to the failure, and only to it.
          error: to === "failed" ? message : null,
          ...(parsed.imageDigest ? { imageDigest: parsed.imageDigest } : {}),
          ...(parsed.engineVersion
            ? { engineVersion: parsed.engineVersion }
            : {}),
          ...(parsed.stackId ? { stackId: parsed.stackId } : {}),
        },
      });
      if (!row) throw new IllegalBuildTransitionError(buildId, from, to);

      const organizationId = await readOrganizationId(tx, row.environmentId);
      await writeAudit(tx, {
        actor: parsed.actor,
        organizationId,
        action: "build.transition",
        subject: buildId,
        detail: {
          ...(parsed.detail ?? {}),
          from,
          to,
          environmentId: row.environmentId,
          ...(message ? { error: message } : {}),
        },
      });

      return row;
    });

    // AFTER the commit, deliberately: an `rm` cannot be rolled back, so a
    // transition that failed to commit must not have retired the artifact of a
    // build that is still going to need it. Best-effort — a disk that refuses
    // the delete is a cleanup problem, never a reason to fail a status write.
    if (isTerminalBuildStatus(to)) {
      await getArtifactStore()
        .remove(updated.artifactPath)
        .catch(() => {});
    }

    return updated;
  }

  /**
   * The oldest build still WAITING for this environment — the head of the
   * queue, and the one a drain should start next.
   *
   * Ordered by `createdAt` so publishes deploy in the order they were sent: the
   * last thing a tenant pushed must be the last thing that lands.
   */
  async nextQueued(input: { environmentId: string }): Promise<BuildRow | null> {
    const { environmentId } = z
      .object({ environmentId: z.uuid() })
      .parse(input);
    const [row] = await this.db
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.environmentId, environmentId),
          eq(builds.status, "queued"),
        ),
      )
      .orderBy(builds.createdAt, builds.id)
      .limit(1);
    return row ?? null;
  }

  /**
   * Append build output, keeping only the last {@link MAX_LOG_TAIL_CHARS}.
   *
   * The bound is applied by Postgres (`right(tail || chunk, N)`) rather than by
   * reading the tail, concatenating in Node and writing it back: that would be
   * a read-modify-write two log writers could interleave and lose output in.
   *
   * Not audited, on purpose. A log append is not a change of meaning, and one
   * build would otherwise write thousands of rows into a trail whose value is
   * that a human can read it.
   */
  async appendLog(input: AppendBuildLogInput): Promise<{ logTail: string }> {
    const { buildId, chunk } = appendLogInputSchema.parse(input);

    const [row] = await this.db
      .update(builds)
      .set({
        logTail: sql`right(coalesce(${builds.logTail}, '') || ${chunk}, ${MAX_LOG_TAIL_CHARS})`,
        updatedAt: new Date(),
      })
      .where(eq(builds.id, buildId))
      .returning({ logTail: builds.logTail });

    if (!row) throw new NotFoundError("Build", buildId);
    return { logTail: row.logTail ?? "" };
  }

  /** One build in full, including its log tail. Null when there is none. */
  async get(input: {
    buildId: string;
    environmentId?: string;
  }): Promise<BuildRow | null> {
    const { buildId, environmentId } = getInputSchema.parse(input);
    const [row] = await this.db
      .select()
      .from(builds)
      .where(
        environmentId
          ? and(eq(builds.id, buildId), eq(builds.environmentId, environmentId))
          : eq(builds.id, buildId),
      )
      .limit(1);
    return row ?? null;
  }

  /** One environment's build history, newest first. Never the log. */
  async list(input: {
    environmentId: string;
    limit?: number;
  }): Promise<ListBuildsResult> {
    const { environmentId, limit } = listInputSchema.parse(input);
    const rows = await this.db
      .select({
        id: builds.id,
        environmentId: builds.environmentId,
        status: builds.status,
        engineVersion: builds.engineVersion,
        imageDigest: builds.imageDigest,
        error: builds.error,
        createdAt: builds.createdAt,
        startedAt: builds.startedAt,
        finishedAt: builds.finishedAt,
      })
      .from(builds)
      .where(eq(builds.environmentId, environmentId))
      .orderBy(desc(builds.createdAt), desc(builds.id))
      .limit(limit);
    return { builds: rows };
  }

  /** The unfinished build for this environment, if there is one. */
  async findActive(input: { environmentId: string }): Promise<BuildRow | null> {
    const { environmentId } = z
      .object({ environmentId: z.uuid() })
      .parse(input);
    const [row] = await this.db
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.environmentId, environmentId),
          inArray(builds.status, ACTIVE_BUILD_STATUSES),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

/**
 * Lock the row and read the status it is in RIGHT NOW.
 *
 * Same reason as `StackService`'s: RETURNING reports the row AFTER the update,
 * so a single statement cannot say where the build came from, and the audit
 * must record the status that actually WAS. `FOR UPDATE` makes the answer
 * exact — a racing transition blocks here, re-reads the winner's committed row,
 * and its own guarded UPDATE then matches nothing.
 */
async function lockBuildStatus(
  writer: CloudWriter,
  buildId: string,
): Promise<{ status: BuildStatus; environmentId: string }> {
  const [current] = await writer
    .select({ status: builds.status, environmentId: builds.environmentId })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1)
    .for("update");
  if (!current) throw new NotFoundError("Build", buildId);
  return current;
}

/**
 * The one guarded write, and the sole enforcement point: `WHERE status IN
 * <legal sources>` means an illegal edge updates zero rows whatever any earlier
 * read believed. Returns null in that case.
 *
 * The OTHER refusal it can meet is the single-flight index, when the edge being
 * written is the claim (`queued → building`) and the environment already has a
 * build running. That is a 23505 from Postgres, and it is given its own voice
 * here so a caller can tell "this build may not start YET" apart from "this
 * build may never make this move".
 */
async function applyBuildStatus(
  writer: CloudWriter,
  args: {
    buildId: string;
    sources: BuildStatus[];
    environmentId: string;
    set: PgUpdateSetSource<typeof builds>;
  },
): Promise<BuildRow | null> {
  // Nothing reaches a status with no legal source, and an empty IN-list is not
  // a query worth building.
  if (args.sources.length === 0) return null;

  try {
    const [row] = await writer
      .update(builds)
      .set(args.set)
      .where(
        and(eq(builds.id, args.buildId), inArray(builds.status, args.sources)),
      )
      .returning();
    return row ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BuildInFlightError(args.environmentId);
    }
    throw error;
  }
}

/**
 * The environment's organization — the tenant every audit row is filed under.
 *
 * Read rather than denormalised onto `builds`: it is one indexed lookup inside
 * a transaction that is already writing, and a copied tenant id is a second
 * source of truth about who owns a build.
 */
async function readOrganizationId(
  writer: CloudWriter,
  environmentId: string,
): Promise<string> {
  const [row] = await writer
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) throw new NotFoundError("Environment", environmentId);
  return row.organizationId;
}

/** Default instance bound to the app pool — the usual import for callers. */
export const buildService = new BuildService();
