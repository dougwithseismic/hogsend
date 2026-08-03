import { and, asc, eq, inArray, lt, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { builds } from "../db/schema";
import {
  ACTIVE_BUILD_STATUSES,
  type BuildService,
  buildService as defaultBuildService,
  RUNNING_BUILD_STATUSES,
} from "../services/builds";
import { StackService } from "../services/stacks";
import { runBuildPipeline } from "./build";

/**
 * The build sweep: the pipeline's backstop, and its reaper.
 *
 * Three jobs, the first two of which exist because the enqueue path is
 * fire-and-forget:
 *
 *  - **Pick up orphans.** A build row is committed BEFORE its task is pushed,
 *    so a control plane that died in that window leaves a `queued` build nobody
 *    is walking. The sweep runs it. This is also what makes the enqueue call
 *    safe to swallow errors from — losing the push costs a minute, not a
 *    publish.
 *  - **Reap the interrupted.** A worker killed mid-build leaves a row in
 *    `building`/`preflight`/`pushing`/`deploying` forever, and — because the
 *    single-flight index forbids a second RUNNING build — that environment can
 *    never publish again. After `staleAfterMs` with no write, the row is failed
 *    with a reason that says what happened. A build reaped out of `deploying`
 *    takes its STACK with it: see {@link parkStackOfReapedBuild}.
 *  - **Drain the queue.** A publish sent while another build was running is a
 *    `queued` row waiting its turn (PRD 08: publishes queue, they never race).
 *    Once the environment's running build reaches a terminal status, the next
 *    tick starts the oldest waiting one.
 *
 * Deliberately serial and small-batched: builds are minutes of docker on a host
 * with finite disk, so a sweep that fanned out would be a self-inflicted
 * outage. Each tick takes at most `limit` builds; the next tick takes the rest.
 */

/** Every minute. A publish that lost its enqueue waits at most that long. */
export const BUILD_SWEEP_CRON = "* * * * *";

/**
 * How long a build may sit in a non-terminal, non-queued status with no write
 * before it is presumed dead. Generously longer than the docker timeout: the
 * cost of reaping a LIVE build is a tenant's publish silently failing, and the
 * cost of waiting is one environment being unable to publish for an hour.
 */
export const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

/** Builds started per tick. One host, one docker daemon — keep it honest. */
export const DEFAULT_SWEEP_LIMIT = 1;

export interface BuildSweepResult {
  started: string[];
  reaped: string[];
  /** Stacks moved out of `publishing` into `error` by a reap. */
  parkedStacks: string[];
}

export interface BuildSweepOptions {
  db?: CloudDb;
  buildService?: BuildService;
  stackService?: StackService;
  limit?: number;
  staleAfterMs?: number;
  now?: () => number;
  /** Injected so a test can assert dispatch without running docker. */
  run?: (buildId: string) => Promise<unknown>;
}

/**
 * Free the STACK of a build that was reaped mid-deploy.
 *
 * The build row is only half the wreckage. `runBuildPipeline` moves the stack
 * `running → publishing` before it calls the substrate and moves it back in a
 * `finally` — so a worker killed in that window leaves the stack in
 * `publishing`, and `publishing` is a status ONLY that function can leave
 * (`LEGAL_EDGES` allows `publishing → running | error`, and both writers live
 * inside one pipeline run). Nothing else in the control plane can rescue it:
 * suspend needs `running`, destroy needs `suspended` or `error`, and the next
 * publish would unpack, build, gate and PUSH before finally refusing at the
 * deploy step. The environment would be permanently unable to publish, and the
 * only cure would be hand-written SQL.
 *
 * So the reap takes the stack with it: `publishing → error`, carrying the same
 * reason, which is a status the existing `error → provisioning` retry edge can
 * leave. Scoped by the stack id the pipeline stamps on the build at the
 * `deploying` write, so this only ever touches the stack THIS build was
 * publishing to.
 *
 * A refusal is expected and silent: `recordError` only accepts a failable
 * source, so a build reaped a moment before it claimed the stack (still
 * `running`) simply parks nothing.
 */
async function parkStackOfReapedBuild(
  stackService: StackService,
  row: { id: string; status: string; stackId: string | null },
): Promise<string | null> {
  if (row.status !== "deploying" || !row.stackId) return null;
  return await stackService
    .recordError({
      stackId: row.stackId,
      error: `[build ${row.id}] the builder was interrupted while deploying; the rollout was never confirmed`,
      step: "publish",
      actor: SWEEP_ACTOR,
    })
    .then(() => row.stackId)
    .catch(() => null);
}

/** The actor recorded on every row the sweep writes. */
const SWEEP_ACTOR = "build-sweep";

export async function sweepBuilds(
  options: BuildSweepOptions = {},
): Promise<BuildSweepResult> {
  const db = options.db ?? defaultDb;
  const service = options.buildService ?? defaultBuildService;
  // Bound to the SAME pool the sweep read through, so a caller that repointed
  // the database does not reap through one connection and park through another.
  const stackService = options.stackService ?? new StackService(db);
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? (() => Date.now());
  const run =
    options.run ?? ((buildId: string) => runBuildPipeline({ buildId }));

  const result: BuildSweepResult = {
    started: [],
    reaped: [],
    parkedStacks: [],
  };

  // Reap first: a stale row is what blocks its environment's next publish, and
  // clearing it is cheap.
  const cutoff = new Date(now() - staleAfterMs);
  const stale = await db
    .select({
      id: builds.id,
      status: builds.status,
      stackId: builds.stackId,
    })
    .from(builds)
    .where(
      and(
        inArray(builds.status, ACTIVE_BUILD_STATUSES),
        ne(builds.status, "queued"),
        lt(builds.updatedAt, cutoff),
      ),
    )
    .limit(50);
  for (const row of stale) {
    // A refused transition is not an error: the build finished between the
    // SELECT and the UPDATE, which is exactly what the guarded write is for.
    const failed = await service
      .transition({
        buildId: row.id,
        to: "failed",
        error: `the builder was interrupted while ${row.status}; publish again to retry`,
        actor: SWEEP_ACTOR,
      })
      .then(() => true)
      .catch(() => false);
    if (!failed) continue;
    result.reaped.push(row.id);

    const parked = await parkStackOfReapedBuild(stackService, row);
    if (parked) result.parkedStacks.push(parked);
  }

  // The queue drain. Two things are load-bearing about this query:
  //  - `not exists (a running build for the same environment)` — a queued build
  //    whose environment is busy cannot start, and picking it anyway would burn
  //    the tick's whole budget on a build that is refused at the claim, leaving
  //    every OTHER tenant's publish waiting behind it;
  //  - oldest first, so an environment's publishes deploy in the order they
  //    were sent.
  const running = alias(builds, "running_build");
  const queued = await db
    .select({ id: builds.id })
    .from(builds)
    .where(
      and(
        eq(builds.status, "queued"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(running)
            .where(
              and(
                eq(running.environmentId, builds.environmentId),
                inArray(running.status, RUNNING_BUILD_STATUSES),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(builds.createdAt), asc(builds.id))
    .limit(limit);
  for (const row of queued) {
    // `runBuildPipeline` leaves a non-`queued` build alone, so a build the
    // enqueue path is ALREADY walking is a no-op here rather than a race.
    await run(row.id);
    result.started.push(row.id);
  }

  return result;
}
