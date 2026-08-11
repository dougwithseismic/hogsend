import {
  ConcurrencyLimitStrategy,
  HatchetClient,
} from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types";
import { env } from "../env";
import { BILLING_SWEEP_CRON, runBillingSweep } from "../metering/sweep";
import { ALERT_SWEEP_CRON, sweepStackAlerts } from "./alert-sweep";
import { runBuildOnHost } from "./build-host";
import { BUILD_SWEEP_CRON, sweepBuilds } from "./build-sweep";
import { HEALTH_SWEEP_CRON, sweepStackHealth } from "./health-poll";
import { runProvisionPipeline } from "./provision";
import { PROVISION_SWEEP_CRON, sweepProvisions } from "./provision-sweep";
import {
  REPUTATION_SWEEP_CRON,
  sweepEmailReputation,
} from "./reputation-sweep";

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

/** The sweep that re-drives provisions Railway's degraded API interrupted. */
export const SWEEP_PROVISIONS_TASK = "sweep-provisions";

/** The sweep that tells a human when a stack needs one (PRD 13 T3). */
export const SWEEP_STACK_ALERTS_TASK = "sweep-stack-alerts";

/** The hourly trust-tier and reputation sweep (PRD 08 tasks 4 and 7). */
export const SWEEP_EMAIL_REPUTATION_TASK = "sweep-email-reputation";

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
      const result = await runBuildOnHost({ buildId });
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

/** The JSON summary a finished provision sweep leaves in Hatchet. */
export interface ProvisionSweepTaskOutput extends JsonObject {
  redriven: string[];
  exhausted: string[];
  needsCredentials: string[];
}

/**
 * The `sweep-provisions` cron task — every five minutes.
 *
 * `retries: 0`, and here the reason is sharper than "the next tick is close".
 * This sweep exists BECAUSE the substrate API is degrading under bursts; a
 * Hatchet retry would answer a substrate failure by immediately making the same
 * calls again, which is precisely the behaviour the sweep replaced. The next
 * tick is the retry, deliberately minutes away.
 *
 * SINGLE-FLIGHT, and this is the task that needs it declaring. The body AWAITS
 * a whole provision, so a tick that spends twenty minutes inside one is still
 * running when the next four cron ticks fire — and unlike `sweep-builds`, the
 * pipeline underneath offers no natural single-flight of its own:
 * `runBuildPipeline` REFUSES a build that is not `queued`, whereas
 * `runProvisionPipeline` deliberately TOLERATES a stack already in
 * `provisioning` (that is what a replayed durable task looks like). So two
 * overlapping ticks would both select the same stale row and drive it at once.
 * Nothing corrupts — the steps are idempotent and every transition is a guarded
 * write — but it reproduces the concurrent burst against Railway's API that the
 * pacing exists to prevent, which is the whole point of the sweep.
 *
 * `CANCEL_NEWEST` is chosen EXPLICITLY, and the explicitness is the point.
 * `limitStrategy` defaults to `CANCEL_IN_PROGRESS`, which here would be
 * actively harmful: each five-minute tick would cancel the sweep already
 * running, killing a live `runProvisionPipeline` mid-flight. A pipeline killed
 * that way never reaches `recordError` — so it leaves a stack abandoned in
 * `provisioning` with its attempt uncounted, which is EXACTLY the wreckage this
 * sweep exists to clean up. Taking the default would have the sweep
 * manufacturing its own workload, once every five minutes, forever. Do not
 * "simplify" this line away.
 *
 * `CANCEL_NEWEST` keeps the incumbent and discards the tick that arrives while
 * it is working, which is the right semantics for a singleton cron: if the
 * previous sweep is still going, this one has nothing to add. The two
 * strategies that also drop or defer the newcomer — `DROP_NEWEST` and
 * `QUEUE_NEWEST` — are both marked deprecated in the SDK's enum, and queueing
 * would anyway build a backlog of identical sweeps and fire them back to back:
 * the burst again, merely deferred. Dropping loses nothing, because the sweep
 * is stateless and the next tick is five minutes away.
 */
function buildProvisionSweepTask(client: HatchetClient) {
  return client.task({
    name: SWEEP_PROVISIONS_TASK,
    onCrons: [PROVISION_SWEEP_CRON],
    retries: 0,
    concurrency: {
      // `expression` is required even though this task takes no input; a
      // constant CEL key is what makes the limit GLOBAL rather than per-run.
      expression: `'${SWEEP_PROVISIONS_TASK}'`,
      maxRuns: 1,
      // Never the default. See the note above.
      limitStrategy: ConcurrencyLimitStrategy.CANCEL_NEWEST,
    },
    // The sweep AWAITS the pipeline it re-drives, so its ceiling is a
    // provision's — the health wait alone is ten minutes.
    executionTimeout: "30m",
    fn: async (): Promise<ProvisionSweepTaskOutput> => {
      const result = await sweepProvisions();
      return {
        redriven: result.redriven,
        exhausted: result.exhausted,
        needsCredentials: result.needsCredentials,
      };
    },
  });
}

export type ProvisionSweepTask = ReturnType<typeof buildProvisionSweepTask>;

let provisionSweepCache: ProvisionSweepTask | undefined;

export function getProvisionSweepTask(
  client: HatchetClient,
): ProvisionSweepTask {
  provisionSweepCache ??= buildProvisionSweepTask(client);
  return provisionSweepCache;
}

/** The JSON summary a finished alert sweep leaves in Hatchet. */
export interface AlertSweepTaskOutput extends JsonObject {
  scanned: number;
  alerted: string[];
  suppressed: number;
  cleared: number;
  failed: string[];
}

/**
 * The `sweep-stack-alerts` cron task — every ten minutes.
 *
 * `retries: 0`, and here the reason is the dedupe record. The sweep SENDS
 * before it records, so a run that died between the send and the write has
 * already told the operator; a retry would tell them the same thing a second
 * time, which is precisely the storm this feature exists to prevent. Losing one
 * tick costs at most ten minutes of silence on a condition that has already
 * lasted thirty.
 *
 * SINGLE-FLIGHT, for the same reason as `sweep-provisions` but with a sharper
 * consequence. Two overlapping ticks would both read `stack_alerts` before
 * either wrote to it, both conclude the condition was unsaid, and both send —
 * the dedupe would be defeated by concurrency alone.
 *
 * `CANCEL_NEWEST` is chosen EXPLICITLY. `limitStrategy` defaults to
 * `CANCEL_IN_PROGRESS`, which here would kill the incumbent sweep partway
 * through its stack loop: the stacks it had already notified would be recorded,
 * the rest would not, and every tick would cancel the previous one at a
 * different point. `CANCEL_NEWEST` keeps the incumbent and discards the
 * newcomer, which is right for a singleton cron — if the previous sweep is
 * still working, this one has nothing to add. Do not "simplify" this line away.
 */
function buildAlertSweepTask(client: HatchetClient) {
  return client.task({
    name: SWEEP_STACK_ALERTS_TASK,
    onCrons: [ALERT_SWEEP_CRON],
    retries: 0,
    concurrency: {
      // A constant CEL key: the task takes no input, and a constant is what
      // makes the limit GLOBAL rather than per-run.
      expression: `'${SWEEP_STACK_ALERTS_TASK}'`,
      maxRuns: 1,
      // Never the default. See the note above.
      limitStrategy: ConcurrencyLimitStrategy.CANCEL_NEWEST,
    },
    // Reads rows and sends a handful of emails; nothing here talks to a
    // substrate. Generous only against a slow mail API.
    executionTimeout: "10m",
    fn: async (): Promise<AlertSweepTaskOutput> => {
      const result = await sweepStackAlerts();
      return {
        scanned: result.scanned,
        alerted: result.alerted.map((entry) => entry.stackId),
        suppressed: result.suppressed,
        cleared: result.cleared.length,
        failed: result.failed,
      };
    },
  });
}

export type AlertSweepTask = ReturnType<typeof buildAlertSweepTask>;

let alertSweepCache: AlertSweepTask | undefined;

export function getAlertSweepTask(client: HatchetClient): AlertSweepTask {
  alertSweepCache ??= buildAlertSweepTask(client);
  return alertSweepCache;
}

/** The JSON summary a finished `sweep-email-reputation` run leaves. */
export interface ReputationSweepTaskOutput extends JsonObject {
  scanned: number;
  promoted: string[];
  demoted: string[];
  suspended: string[];
  failed: number;
}

/**
 * The `sweep-email-reputation` cron task (PRD 08).
 *
 * SINGLE-FLIGHT for the same reason the alert sweep is, and with the same
 * sharper consequence: two overlapping ticks would both read a tenant's
 * sending status before either wrote one, both conclude it was still sending,
 * and both suspend it — which means both would find a transition and both would
 * mail the customer. The notice's once-per-pause-event guarantee is enforced by
 * the transition check, and a transition check is only single-valued if the
 * sweep is.
 *
 * `retries: 0`. Every step is idempotent, so a retry would be safe — and
 * pointless: a failure that survived the first attempt survives a second one
 * minutes later, and the next tick is an hour away with the same numbers to
 * read. A per-tenant failure never reaches this level; the sweep records it and
 * steps over.
 */
function buildReputationSweepTask(client: HatchetClient) {
  return client.task({
    name: SWEEP_EMAIL_REPUTATION_TASK,
    onCrons: [REPUTATION_SWEEP_CRON],
    retries: 0,
    concurrency: {
      expression: `'${SWEEP_EMAIL_REPUTATION_TASK}'`,
      maxRuns: 1,
      // Never the default. Cancelling the incumbent mid-fleet would leave the
      // tenants it had not reached unexamined on every single tick.
      limitStrategy: ConcurrencyLimitStrategy.CANCEL_NEWEST,
    },
    // Reads counters and makes at most one AWS call per transitioning tenant.
    executionTimeout: "30m",
    fn: async (): Promise<ReputationSweepTaskOutput> => {
      const result = await sweepEmailReputation();
      return {
        scanned: result.scanned,
        promoted: result.promoted.map((entry) => entry.environmentId),
        demoted: result.demoted.map((entry) => entry.environmentId),
        suspended: result.suspended.map((entry) => entry.environmentId),
        failed: result.failed.length,
      };
    },
  });
}

export type ReputationSweepTask = ReturnType<typeof buildReputationSweepTask>;

let reputationSweepCache: ReputationSweepTask | undefined;

export function getReputationSweepTask(
  client: HatchetClient,
): ReputationSweepTask {
  reputationSweepCache ??= buildReputationSweepTask(client);
  return reputationSweepCache;
}
