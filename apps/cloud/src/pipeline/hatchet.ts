import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types";
import { env } from "../env";
import { BILLING_SWEEP_CRON, runBillingSweep } from "../metering/sweep";
import { runBuildPipeline } from "./build";
import { BUILD_SWEEP_CRON, sweepBuilds } from "./build-sweep";
import { HEALTH_SWEEP_CRON, sweepStackHealth } from "./health-poll";
import { runProvisionPipeline } from "./provision";

/**
 * The CONTROL PLANE's Hatchet client and its durable tasks.
 *
 * Three things are deliberate here:
 *  - the namespace is `cloud`, fixed. The control plane shares cell Hatchets
 *    with tenant stacks, and a tenant must never see (or be able to trigger) a
 *    provisioning task;
 *  - the client is built LAZILY and cached. Importing this module must be free:
 *    the Next app imports the enqueue path on every request, and constructing a
 *    gRPC client at import time would open a connection from the web process
 *    even when the token is absent;
 *  - `getCloudHatchet()` returns `null` rather than throwing when no token is
 *    configured. Whether that is fatal is the CALLER's rule — the worker fails
 *    closed on it, the enqueue path falls back to the in-process runner under
 *    the fake substrate — and encoding one of those answers here would take the
 *    choice away from both.
 */

/** The control plane's Hatchet namespace. Never a tenant's. */
export const CLOUD_HATCHET_NAMESPACE = "cloud";

/** The durable task name. Also the Hatchet dashboard's label. */
export const PROVISION_STACK_TASK = "provision-stack";

/** The recurring health sweep (PRD 04 task 4). Cron-triggered, never enqueued. */
export const SWEEP_STACK_HEALTH_TASK = "sweep-stack-health";

/** The nightly metering + enforcement + dunning sweep (PRD 06 task 3). */
export const SWEEP_BILLING_TASK = "sweep-billing";

/** One publish artifact walked to a deployed image (PRD 08 task 3). */
export const RUN_BUILD_TASK = "run-build";

/** The minute sweep that picks up orphaned builds and reaps stale ones. */
export const SWEEP_BUILDS_TASK = "sweep-builds";

export interface ProvisionStackInput extends JsonObject {
  stackId: string;
}

/** The JSON summary a finished `provision-stack` run leaves in Hatchet. */
export interface ProvisionTaskOutput extends JsonObject {
  stackId: string;
  status: "running" | "error";
  steps: string[];
  skipped: string[];
  failedStep: string | null;
  error: string | null;
}

let cached: HatchetClient | undefined;

/** The cloud Hatchet client, or null when `CLOUD_HATCHET_CLIENT_TOKEN` is unset. */
export function getCloudHatchet(): HatchetClient | null {
  if (!env.CLOUD_HATCHET_CLIENT_TOKEN) return null;
  cached ??= HatchetClient.init({
    token: env.CLOUD_HATCHET_CLIENT_TOKEN,
    host_port: env.CLOUD_HATCHET_CLIENT_HOST_PORT,
    tls_config: { tls_strategy: env.CLOUD_HATCHET_CLIENT_TLS_STRATEGY },
    namespace: CLOUD_HATCHET_NAMESPACE,
  });
  return cached;
}

/**
 * The `provision-stack` durable task. Built on demand (it needs a client) and
 * cached, so the worker registers exactly one and the enqueue path triggers
 * that same one.
 *
 * Retries are Hatchet's, and are safe BECAUSE every pipeline step is idempotent
 * on its persisted artifact: a retried run resumes rather than duplicating a
 * tenant database or a substrate stack.
 */
function buildProvisionStackTask(client: HatchetClient) {
  return client.task({
    name: PROVISION_STACK_TASK,
    // One retry covers a transient substrate/cell blip; anything beyond that is
    // an operator decision made from the dashboard, not a loop that burns money
    // against a permanently broken cell.
    retries: 1,
    executionTimeout: "15m",
    // Hatchet types a task's input as a bare JSON object, so the one field this
    // task needs is validated HERE rather than assumed: an event carrying no
    // stack id must fail loudly, not provision `undefined`.
    fn: async (input: JsonObject): Promise<ProvisionTaskOutput> => {
      const stackId = input.stackId;
      if (typeof stackId !== "string" || stackId.length === 0) {
        throw new Error(
          `${PROVISION_STACK_TASK} requires a string "stackId" input`,
        );
      }
      const result = await runProvisionPipeline({ stackId });
      // Flattened to plain JSON: Hatchet persists a task's output, and the
      // dashboard reads it. The row is the source of truth for detail.
      return {
        stackId: result.stackId,
        status: result.status,
        steps: result.steps.map((step) => step.step),
        skipped: result.steps
          .filter((step) => step.skipped)
          .map((step) => step.step),
        failedStep: result.status === "error" ? result.failedStep : null,
        error: result.status === "error" ? result.error : null,
      };
    },
  });
}

export type ProvisionStackTask = ReturnType<typeof buildProvisionStackTask>;

let taskCache: ProvisionStackTask | undefined;

export function getProvisionStackTask(
  client: HatchetClient,
): ProvisionStackTask {
  taskCache ??= buildProvisionStackTask(client);
  return taskCache;
}

/** The JSON summary a finished health sweep leaves in Hatchet. */
export interface HealthSweepTaskOutput extends JsonObject {
  checked: number;
  healthy: number;
  unhealthy: number;
}

/**
 * The `sweep-stack-health` cron task — every minute, every `running` stack.
 *
 * `retries: 0` on purpose: the sweep is idempotent in the harmless sense (a
 * re-run just writes another observation), but a retried sweep would write a
 * SECOND row for the same minute and shorten the "3 consecutive sweeps" window
 * to something less than three minutes. Missing one minute is cheaper than
 * corrupting the streak the alert rule is built on — the next cron tick is 60
 * seconds away.
 */
function buildHealthSweepTask(client: HatchetClient) {
  return client.task({
    name: SWEEP_STACK_HEALTH_TASK,
    onCrons: [HEALTH_SWEEP_CRON],
    retries: 0,
    executionTimeout: "5m",
    fn: async (): Promise<HealthSweepTaskOutput> => {
      const result = await sweepStackHealth();
      return {
        checked: result.checked,
        healthy: result.healthy,
        unhealthy: result.unhealthy,
      };
    },
  });
}

export type HealthSweepTask = ReturnType<typeof buildHealthSweepTask>;

let sweepCache: HealthSweepTask | undefined;

export function getHealthSweepTask(client: HatchetClient): HealthSweepTask {
  sweepCache ??= buildHealthSweepTask(client);
  return sweepCache;
}

/** The JSON summary a finished billing sweep leaves in Hatchet. */
export interface BillingSweepTaskOutput extends JsonObject {
  month: string;
  metered: number;
  meteringFailures: number;
  ingestSuspended: number;
  ingestResumed: number;
  trialsExpired: number;
  dunningSuspended: number;
}

/**
 * The `sweep-billing` cron task — nightly: meter, enforce, expire the grace.
 *
 * `retries: 0`, for a sharper reason than the health sweep's. Every step is
 * idempotent, so a retry would be SAFE — but it would also be pointless: a
 * failure that survived the first attempt (an unreachable substrate, a cell
 * that is down) will survive a second one minutes later, and the next tick is
 * 24 hours away with the same absolute numbers to write. A per-tenant failure
 * never reaches this level at all: the sweep records it and steps over.
 */
function buildBillingSweepTask(client: HatchetClient) {
  return client.task({
    name: SWEEP_BILLING_TASK,
    onCrons: [BILLING_SWEEP_CRON],
    retries: 0,
    // A fleet of tenant databases, visited in sequence with a 10s connect
    // timeout each. Generous, because being cut off mid-fleet would leave half
    // the tenants un-metered for the night.
    executionTimeout: "60m",
    fn: async (): Promise<BillingSweepTaskOutput> => {
      const result = await runBillingSweep();
      return {
        month: result.usage.month,
        metered: result.usage.swept,
        meteringFailures: result.usage.failed.length,
        ingestSuspended: result.enforcement.actions.filter(
          (action) => action.verdict === "ingest_suspended",
        ).length,
        ingestResumed: result.enforcement.actions.filter(
          (action) => action.verdict === "ingest_resumed",
        ).length,
        trialsExpired: result.enforcement.trialsExpired.length,
        dunningSuspended: result.dunning.suspended.length,
      };
    },
  });
}

export type BillingSweepTask = ReturnType<typeof buildBillingSweepTask>;

let billingSweepCache: BillingSweepTask | undefined;

export function getBillingSweepTask(client: HatchetClient): BillingSweepTask {
  billingSweepCache ??= buildBillingSweepTask(client);
  return billingSweepCache;
}

export interface RunBuildInput extends JsonObject {
  buildId: string;
}

/** The JSON summary a finished `run-build` leaves in Hatchet. */
export interface RunBuildTaskOutput extends JsonObject {
  buildId: string;
  status: "succeeded" | "failed" | "skipped";
  steps: string[];
  failedStep: string | null;
  error: string | null;
  reference: string | null;
  imageDigest: string | null;
}

/**
 * The `run-build` durable task.
 *
 * `retries: 0`, and that is a rule rather than a tuning choice. A `builds` row
 * records ONE attempt — the state machine has no edge back into the middle of
 * the pipeline, and a retry is a NEW row with its own artifact and its own log
 * (`services/builds.ts`). A Hatchet retry would replay a task whose build is no
 * longer `queued`, which the pipeline correctly refuses; making that the normal
 * path would just hide failures behind a "skipped" result.
 *
 * The timeout is generous because a cold docker build of a whole app —
 * dependency fetch, tsup, a pruned runner — is minutes, and being cut off
 * halfway leaves a stale row for the sweep to reap for no gain.
 */
function buildRunBuildTask(client: HatchetClient) {
  return client.task({
    name: RUN_BUILD_TASK,
    retries: 0,
    executionTimeout: "60m",
    fn: async (input: JsonObject): Promise<RunBuildTaskOutput> => {
      const buildId = input.buildId;
      if (typeof buildId !== "string" || buildId.length === 0) {
        throw new Error(`${RUN_BUILD_TASK} requires a string "buildId" input`);
      }
      const result = await runBuildPipeline({ buildId });
      return {
        buildId: result.buildId,
        status: result.status,
        steps: result.steps,
        failedStep: result.failedStep ?? null,
        error: result.error ?? null,
        reference: result.reference ?? null,
        imageDigest: result.imageDigest ?? null,
      };
    },
  });
}

export type RunBuildTask = ReturnType<typeof buildRunBuildTask>;

let runBuildCache: RunBuildTask | undefined;

export function getRunBuildTask(client: HatchetClient): RunBuildTask {
  runBuildCache ??= buildRunBuildTask(client);
  return runBuildCache;
}

/** The JSON summary a finished build sweep leaves in Hatchet. */
export interface BuildSweepTaskOutput extends JsonObject {
  started: string[];
  reaped: string[];
}

/**
 * The `sweep-builds` cron task — every minute.
 *
 * `retries: 0` for the health sweep's reason: the sweep is idempotent, but a
 * retry would only re-run a minute early, and the next tick is 60 seconds away.
 */
function buildBuildSweepTask(client: HatchetClient) {
  return client.task({
    name: SWEEP_BUILDS_TASK,
    onCrons: [BUILD_SWEEP_CRON],
    retries: 0,
    // The sweep AWAITS the build it starts, so its ceiling is a build's.
    executionTimeout: "60m",
    fn: async (): Promise<BuildSweepTaskOutput> => {
      const result = await sweepBuilds();
      return { started: result.started, reaped: result.reaped };
    },
  });
}

export type BuildSweepTask = ReturnType<typeof buildBuildSweepTask>;

let buildSweepCache: BuildSweepTask | undefined;

export function getBuildSweepTask(client: HatchetClient): BuildSweepTask {
  buildSweepCache ??= buildBuildSweepTask(client);
  return buildSweepCache;
}
