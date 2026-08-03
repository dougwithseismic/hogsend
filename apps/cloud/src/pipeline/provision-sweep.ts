import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { stacks } from "../db/schema";
import { StackService } from "../services/stacks";
import { PROVISION_STEPS, runProvisionPipeline } from "./provision";

/**
 * The provision sweep: the thing that finishes what Railway interrupted.
 *
 * It exists because of a property of the substrate, not of the pipeline.
 * Railway's API degrades for calls made from INSIDE Railway: the control-plane
 * worker's provisioning bursts draw persistent `Problem processing request`
 * 400s, while the very same pipeline run from a laptop completes every call.
 * The inline retry budget was already widened to ~63s and still exhausted, so
 * the failure mode is not "one call was unlucky" — it is "this whole burst is
 * unlucky, try again later from a different burst". A longer inline retry only
 * buys a longer stall; a LATER attempt is what actually converges.
 *
 * That is safe to do precisely because of PRD 04's first law: every provision
 * step is idempotent and proves it from PERSISTED state (an encrypted DSN, an
 * encrypted Hatchet token, `substrate_refs`). A re-drive therefore resumes at
 * the step that failed rather than re-creating a tenant database, and each tick
 * advances the stack by at least the steps that had already landed. The
 * pipeline has no memory of its own — only the row's — which is exactly what
 * makes a cron a legitimate second caller.
 *
 * Three conditions bring a stack here, and only the first two are dispatched:
 *
 *  - **Parked at a provision step.** `status = 'error'` with a `last_error`
 *    naming one of {@link PROVISION_STEPS}. `error → provisioning` is a legal
 *    edge and the pipeline's `start` step already handles the resume, so this
 *    is the dashboard's "retry" button on a timer.
 *  - **Abandoned mid-provision.** `status = 'provisioning'` with no write for
 *    longer than the stale window — a worker killed between two steps, which
 *    nothing else in the control plane would ever notice. This one is PARKED
 *    first and then re-driven; see {@link parkAbandonedProvision}.
 *  - **Running without credentials.** DETECTED AND REPORTED, never dispatched.
 *    See {@link findStacksNeedingCredentials}.
 *
 * Deliberately serial and small-batched, with a pause between re-drives. The
 * sweep runs inside Railway too, so it inherits the SAME degraded egress it is
 * retrying against: a tick that fanned out would reproduce the burst that
 * caused the outage. Pacing is part of the fix, not a nicety.
 */

/**
 * Every five minutes. Deliberately less frequent than the build sweep's every
 * minute: each tick makes real substrate calls against an API that is degrading
 * under exactly this kind of traffic, and a provision is minutes of work, so a
 * minute cron would mostly be re-driving stacks whose previous re-drive is
 * still in flight. Five minutes is inside a customer's patience and outside the
 * pipeline's own working window.
 */
export const PROVISION_SWEEP_CRON = "*/5 * * * *";

/**
 * How long a stack may sit in `provisioning` with no write before it is
 * presumed abandoned. Longer than the pipeline's own health wait (ten minutes),
 * because a stack in the middle of that wait is NOT stuck, and re-driving it
 * would race a live run against itself.
 */
export const DEFAULT_PROVISION_STALE_AFTER_MS = 15 * 60 * 1000;

/** Stacks re-driven per tick. Serial, and one is honest by default. */
export const DEFAULT_PROVISION_SWEEP_LIMIT = 1;

/**
 * Attempts since the last SUCCESS after which a stack stops being re-driven.
 *
 * The counter is the EXISTING `stacks.retry_count`: `StackService.recordError`
 * increments it on every parked failure and `transition` resets it to zero on
 * `running`, which is precisely "attempts since the last success". A second
 * column would have to be kept in step with that one, and would drift.
 *
 * Note that this is only a real bound because an abandoned `provisioning` stack
 * is PARKED before it is re-driven ({@link parkAbandonedProvision}) — a worker
 * killed mid-run never reaches `recordError` itself, so without that step a
 * stack that is abandoned at the same step every time would be re-driven
 * forever, never cross the ceiling, and never raise the T3 alert.
 *
 * Five, because the failures this sweep exists for are transient-but-persistent
 * — a degraded window lasting tens of minutes — and five ticks spans it. Past
 * that the failure is a different KIND (a misconfigured cell, a revoked token),
 * and re-driving it forever is its own outage: it burns substrate quota and
 * buries the real signal. T3 turns an exhausted stack into an alert.
 */
export const DEFAULT_PROVISION_ATTEMPT_CEILING = 5;

/** The gap between two re-drives in one tick. See the module comment. */
export const DEFAULT_PROVISION_PACING_MS = 2000;

/**
 * The statuses a sweep may re-drive. Everything else is off limits, and for
 * reasons rather than caution: `suspended`, `destroying` and `destroyed` are
 * states a HUMAN put the stack into (or is deliberately tearing down), and
 * `publishing` belongs to the build sweep, which owns the only edges out of it.
 */
const REDRIVABLE_STATUSES = ["error", "provisioning"] as const;

export interface ProvisionSweepResult {
  /** Stacks handed to the pipeline this tick. */
  redriven: string[];
  /** Stacks past the attempt ceiling — left alone, and worth alerting on. */
  exhausted: string[];
  /** `running` stacks with no minted credentials. Reported, never dispatched. */
  needsCredentials: string[];
}

export interface ProvisionSweepOptions {
  db?: CloudDb;
  stackService?: StackService;
  limit?: number;
  staleAfterMs?: number;
  attemptCeiling?: number;
  pacingMs?: number;
  now?: () => number;
  /** Injected so a test can assert pacing without spending the wall clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can assert dispatch without calling a substrate. */
  run?: (stackId: string) => Promise<unknown>;
}

/** The `[step] message` shape `runProvisionPipeline` records on a failure. */
const PROVISION_STEP_NAMES = new Set<string>(PROVISION_STEPS);

/**
 * Did this stack fail INSIDE the provisioning pipeline?
 *
 * `last_error` is written by `StackService.recordError`, and the provisioner
 * prefixes it with the failed step (`[set-env] …`). Other writers park stacks
 * in `error` too — the build sweep's `[build …]` reap, most notably — and those
 * are not ours: a stack parked by a failed PUBLISH has an image problem, and
 * re-provisioning it would re-run substrate steps that all skip and then
 * declare it `running` on the old image, hiding the failure the operator needs
 * to see.
 */
function failedInProvisioning(lastError: string | null): boolean {
  const match = /^\[([^\]]+)\]/.exec(lastError ?? "");
  return match ? PROVISION_STEP_NAMES.has(match[1] ?? "") : false;
}

/** The actor recorded on every row the sweep writes. */
const SWEEP_ACTOR = "provision-sweep";

/**
 * Record the abandonment BEFORE re-driving it: `provisioning → error`, then let
 * the pipeline take the `error → provisioning` edge back out.
 *
 * The detour exists because of who increments the counter. `retry_count` is
 * written only by `StackService.recordError`, which runs when the PIPELINE
 * parks a stack — and a worker killed mid-provision never gets that far. So a
 * stack abandoned at the same step every time (a worker that OOMs there, which
 * is exactly the failure class this sweep exists for) would be re-driven every
 * tick forever, never reach the ceiling, and never raise the T3 alert: a
 * control plane failing quietly inside the mechanism meant to stop it.
 *
 * Parking through the existing writer fixes that with no new column and no
 * second counter to drift: the attempt is counted, the audit trail names the
 * abandonment instead of implying it by an absence, and the very next tick
 * evaluates the stack under the ordinary `error` rule. The message carries a
 * `[start]` prefix deliberately — that is the step a resume begins at, and it
 * is what {@link failedInProvisioning} needs to recognise the row as ours.
 *
 * A refusal is expected and silent: the stack reached `running` between the
 * SELECT and the UPDATE, which is the guarded write doing its job. Returns
 * false in that case, and the caller then leaves the row alone rather than
 * re-driving a stack that just finished.
 */
async function parkAbandonedProvision(
  stackService: StackService,
  stackId: string,
): Promise<boolean> {
  return await stackService
    .recordError({
      stackId,
      error:
        "[start] the provisioner was interrupted while provisioning; the sweep is re-driving it",
      step: "start",
      actor: SWEEP_ACTOR,
    })
    .then(() => true)
    .catch(() => false);
}

/**
 * `running` stacks whose `mint-credentials` never landed.
 *
 * The seam this reports on: the pipeline marks a stack `running` at `finish`,
 * so a mint that did not succeed leaves a stack that LOOKS healthy, is inert
 * (no Studio admin, no API key), and matches neither of the re-drivable
 * conditions.
 *
 * Reported and NOT dispatched, for two independent reasons — either alone would
 * be enough:
 *  - `LEGAL_EDGES` has no `running → provisioning` edge, and `runProvisionPipeline`
 *    early-returns for a `running` stack, so this case cannot travel through the
 *    pipeline at all; and
 *  - `mint-credentials` is still a recorded no-op (`provision.ts`), so a
 *    dispatch today would burn the attempt ceiling on a step that cannot yet
 *    succeed.
 *
 * PRD 13 **T2** replaces the stub with a real mint and closes this seam; the
 * ids this sweep surfaces are what it will act on.
 */
async function findStacksNeedingCredentials(db: CloudDb): Promise<string[]> {
  const rows = await db
    .select({ id: stacks.id })
    .from(stacks)
    .where(
      and(
        eq(stacks.status, "running"),
        // `IS DISTINCT FROM` rather than `!=`: a stack provisioned before the
        // key existed carries no `credentialsMinted` at all, and a NULL
        // comparison would silently drop exactly the oldest cases.
        sql`${stacks.substrateRefs} ->> 'credentialsMinted' is distinct from 'true'`,
      ),
    )
    .orderBy(asc(stacks.updatedAt), asc(stacks.id))
    .limit(50);
  return rows.map((row) => row.id);
}

export async function sweepProvisions(
  options: ProvisionSweepOptions = {},
): Promise<ProvisionSweepResult> {
  const db = options.db ?? defaultDb;
  // Bound to the SAME pool the sweep read through, so a caller that repointed
  // the database does not select through one connection and park through
  // another.
  const stackService = options.stackService ?? new StackService(db);
  const limit = options.limit ?? DEFAULT_PROVISION_SWEEP_LIMIT;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PROVISION_STALE_AFTER_MS;
  const attemptCeiling =
    options.attemptCeiling ?? DEFAULT_PROVISION_ATTEMPT_CEILING;
  const pacingMs = options.pacingMs ?? DEFAULT_PROVISION_PACING_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const run =
    options.run ?? ((stackId: string) => runProvisionPipeline({ stackId }));

  const result: ProvisionSweepResult = {
    redriven: [],
    exhausted: [],
    needsCredentials: await findStacksNeedingCredentials(db),
  };

  // Both re-drivable conditions in one read, then separated in JS. The status
  // filter is what the index serves; the two refinements — which step the error
  // names, and how long a `provisioning` row has been silent — are per-row
  // judgements that read far better here than as a compound SQL predicate.
  const cutoff = new Date(now() - staleAfterMs);
  const candidates = await db
    .select({
      id: stacks.id,
      status: stacks.status,
      lastError: stacks.lastError,
      retryCount: stacks.retryCount,
      updatedAt: stacks.updatedAt,
    })
    .from(stacks)
    .where(inArray(stacks.status, [...REDRIVABLE_STATUSES]))
    // Oldest first: a stack that has been parked longest has waited longest,
    // and a tick takes only `limit` of them.
    .orderBy(asc(stacks.updatedAt), asc(stacks.id))
    .limit(200);

  let dispatched = 0;
  for (const row of candidates) {
    if (dispatched >= limit) break;

    const eligible =
      row.status === "error"
        ? failedInProvisioning(row.lastError)
        : row.updatedAt < cutoff;
    if (!eligible) continue;

    // The ceiling is checked AFTER eligibility so `exhausted` names only stacks
    // this sweep would otherwise have re-driven — an operator reading it wants
    // "gave up on these", not "every row in the table".
    if (row.retryCount >= attemptCeiling) {
      result.exhausted.push(row.id);
      continue;
    }

    // An abandoned run is recorded as the failure it is before it is retried,
    // which is what makes the ceiling above bind at all. A refusal means the
    // stack finished on its own; leave it entirely.
    if (row.status === "provisioning") {
      if (!(await parkAbandonedProvision(stackService, row.id))) continue;
    }

    // Between re-drives, never before the first: the pause exists to spread
    // substrate calls, and a tick that slept before doing any work would only
    // delay the recovery it was scheduled for.
    if (dispatched > 0 && pacingMs > 0) await sleep(pacingMs);

    // `runProvisionPipeline` returns rather than throws on a step failure — it
    // parks the stack itself — so a throw here is the unexpected case: a lost
    // race (an operator suspending the stack between the SELECT and the
    // transition) or a substrate that could not even be constructed. Silent,
    // exactly as in the build sweep, but NOT counted as a re-drive: `redriven`
    // is what an operator reads to see what the tick actually attempted, and a
    // dispatch that threw advanced nothing.
    dispatched += 1;
    const ran = await run(row.id).then(
      () => true,
      () => false,
    );
    if (ran) result.redriven.push(row.id);
  }

  return result;
}
