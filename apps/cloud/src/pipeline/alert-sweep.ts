import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, organizations, stackAlerts, stacks } from "../db/schema";
import { env } from "../env";
import type { EmailSender } from "../lib/email-sender";
import { logSender, resolveEmailSender } from "../lib/email-sender";
import type {
  StackAlertCondition,
  StackAlertFacts,
} from "../lib/stack-alert-notice";
import { stackAlertBody, stackAlertSubject } from "../lib/stack-alert-notice";
import { failedProvisionStep } from "./provision";
import {
  DEFAULT_PROVISION_ATTEMPT_CEILING,
  DEFAULT_PROVISION_STALE_AFTER_MS,
} from "./provision-sweep";

/**
 * The alert sweep: the thing that tells a human when no cron can finish the
 * job.
 *
 * A sweep with no alert is a quieter version of the bug it was built to fix.
 * The provision sweep re-drives what Railway's degraded API interrupted, and
 * for the transient-but-persistent failures it exists for, that converges. Some
 * failure classes never do — a misconfigured cell, a revoked token, the
 * `Not Authorized` class already in RUNBOOK.md — and during a private beta
 * nobody is watching a dashboard. So the control plane has to speak first.
 *
 * Three conditions, and they overlap on purpose: the first is a net wide enough
 * to catch a failure nobody predicted, and the other two name the two shapes we
 * already know converge to nothing.
 *
 *  - **`non_running`** — any stack in a non-`running` status for longer than
 *    the threshold. Deliberately status-agnostic: a stack parked in `requested`
 *    because the enqueue never landed is just as broken as one in `error`, and
 *    a rule that enumerated the interesting statuses would miss the one nobody
 *    thought of.
 *  - **`provision_exhausted`** — past the provision sweep's attempt ceiling.
 *    Nothing will retry it again; that is the whole content of the alert.
 *  - **`needs_credentials`** — `running` but inert. It matches nothing else:
 *    the health poll calls it healthy, the provision sweep reports it and
 *    (correctly) refuses to dispatch it, and the customer sees an instance they
 *    cannot log into.
 *
 * DEDUPE IS THE FEATURE, not a refinement of it. Every one of these conditions
 * matches PERSISTENTLY — `needs_credentials` matches on every tick until T2
 * ships, `provision_exhausted` until a human acts — so a sweep that simply sent
 * what it found would page the operator every five minutes forever, and an
 * alert that cries wolf is worse than no alert. What has already been said is
 * recorded in `cloud.stack_alerts`, per stack and per condition, and is
 * repeated only when the condition CHANGES for that stack or after a long
 * cooldown. See the table's own comment for why it is persisted rather than
 * held in a module-level Set.
 *
 * The sweep NEVER transitions a stack, exactly like the health poll. Alerting
 * on a broken stack and then acting on it are two different decisions, and only
 * one of them belongs to a cron.
 */

/**
 * Every ten minutes. Slower than the health poll's minute because the fastest
 * condition here already has a thirty-minute threshold in front of it, and
 * slower ticks mean fewer chances to race the provision sweep's own writes.
 */
export const ALERT_SWEEP_CRON = "*/10 * * * *";

/**
 * Statuses a non-`running` stack may sit in without anyone being told.
 *
 * All three are the RESULT of a deliberate action — an operator suspending a
 * tenant, a destroy running or finished. Alerting on them would page a human
 * about a thing that human just did, which is the fastest way to teach them to
 * filter the channel.
 */
const UNALERTED_STATUSES = new Set(["suspended", "destroying", "destroyed"]);

/**
 * Did this stack fail inside the provisioning pipeline?
 *
 * The SAME predicate the provision sweep filters on, shared rather than
 * mirrored, because `provision_exhausted` must name exactly the stacks that
 * sweep gave up on — a stack parked in `error` by a failed BUILD was never a
 * provision candidate, so it was never re-driven and its `retry_count` says
 * nothing about a provision ceiling. It still reaches an operator through
 * `non_running`.
 */
function failedInProvisioning(lastError: string | null): boolean {
  return failedProvisionStep(lastError) !== null;
}

export interface AlertSweepOptions {
  db?: CloudDb;
  /** Injected so a test asserts what was sent without a transport. */
  sender?: EmailSender;
  /** Absent → the notice goes to the log transport. See `resolveDestination`. */
  destination?: string | null;
  nonRunningAfterMs?: number;
  cooldownMs?: number;
  attemptCeiling?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

export interface AlertSweepResult {
  /** Stacks examined this tick. */
  scanned: number;
  /** One entry per stack actually notified, with the conditions it carried. */
  alerted: { stackId: string; conditions: StackAlertCondition[] }[];
  /** Firing conditions the dedupe record silenced. The quiet is measurable. */
  suppressed: number;
  /** Conditions that stopped matching and were recorded as cleared. */
  cleared: { stackId: string; condition: StackAlertCondition }[];
  /** Stacks whose notice could not be sent; unrecorded, so retried next tick. */
  failed: string[];
}

/**
 * Where notices go, and the transport that carries them.
 *
 * With no `CLOUD_OPERATOR_EMAIL` the destination is a placeholder address and
 * the transport is forced to `logSender` — the same fallback the signup OTP
 * takes. That is what lets a fresh clone run the sweep with no configuration,
 * and it is also the guard: a misconfigured deploy cannot mail a stranger,
 * because with no destination there is no network transport to mail them with.
 */
function resolveDestination(destination: string | null): {
  to: string;
  sender: EmailSender;
} {
  if (!destination) return { to: "operator@localhost", sender: logSender };
  return { to: destination, sender: resolveEmailSender() };
}

/** The signature of what was said, so a CHANGE can be told from a repeat. */
function fingerprint(
  condition: StackAlertCondition,
  row: { status: string; retryCount: number },
): string {
  // `provision_exhausted` carries the attempt count because the ceiling can be
  // raised, and a stack that crossed a higher one is a new fact. The other two
  // are fully described by the status they fired on.
  return condition === "provision_exhausted"
    ? `${row.status}:${row.retryCount}`
    : row.status;
}

export async function sweepStackAlerts(
  options: AlertSweepOptions = {},
): Promise<AlertSweepResult> {
  const db = options.db ?? defaultDb;
  const now = (options.now ?? (() => new Date()))();
  const nonRunningAfterMs =
    options.nonRunningAfterMs ??
    env.CLOUD_ALERT_NON_RUNNING_AFTER_MINUTES * 60 * 1000;
  const cooldownMs =
    options.cooldownMs ?? env.CLOUD_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
  const attemptCeiling =
    options.attemptCeiling ?? DEFAULT_PROVISION_ATTEMPT_CEILING;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PROVISION_STALE_AFTER_MS;
  const destination =
    options.destination !== undefined
      ? options.destination
      : (env.CLOUD_OPERATOR_EMAIL ?? null);
  const { to, sender } = options.sender
    ? { to: destination ?? "operator@localhost", sender: options.sender }
    : resolveDestination(destination);

  const result: AlertSweepResult = {
    scanned: 0,
    alerted: [],
    suppressed: 0,
    cleared: [],
    failed: [],
  };

  // The org and environment names are joined in rather than looked up per
  // alert: an operator identifies a tenant by name, and a notice that carried
  // only uuids would need a database to be readable.
  const rows = await db
    .select({
      id: stacks.id,
      organizationId: stacks.organizationId,
      organizationName: organizations.name,
      environmentName: environments.name,
      status: stacks.status,
      lastError: stacks.lastError,
      retryCount: stacks.retryCount,
      updatedAt: stacks.updatedAt,
      substrateRefs: stacks.substrateRefs,
    })
    .from(stacks)
    .innerJoin(organizations, eq(organizations.id, stacks.organizationId))
    .innerJoin(environments, eq(environments.id, stacks.environmentId));
  result.scanned = rows.length;

  const firing = new Map<string, StackAlertCondition[]>();
  for (const row of rows) {
    const ageMs = now.getTime() - row.updatedAt.getTime();
    const conditions: StackAlertCondition[] = [];

    if (
      row.status !== "running" &&
      !UNALERTED_STATUSES.has(row.status) &&
      ageMs >= nonRunningAfterMs
    ) {
      conditions.push("non_running");
    }

    const provisionCandidate =
      row.status === "error"
        ? failedInProvisioning(row.lastError)
        : row.status === "provisioning" && ageMs >= staleAfterMs;
    if (provisionCandidate && row.retryCount >= attemptCeiling) {
      conditions.push("provision_exhausted");
    }

    if (
      row.status === "running" &&
      row.substrateRefs.credentialsMinted !== true
    ) {
      conditions.push("needs_credentials");
    }

    if (conditions.length > 0) firing.set(row.id, conditions);
  }

  // Every remembered alert, read once. The table holds at most one row per
  // (stack, condition), so this is bounded by the fleet and cheaper than a
  // per-stack lookup inside the loop.
  const remembered = await db.select().from(stackAlerts);

  // A condition that stopped matching is recorded as cleared BEFORE anything is
  // sent, and this ordering is the point: a stale uncleared record inside the
  // cooldown would silence the recurrence of a condition that had genuinely
  // gone away, which is the failure mode that makes dedupe dangerous rather
  // than merely noisy.
  for (const record of remembered) {
    if (record.clearedAt !== null) continue;
    const live = firing.get(record.stackId) ?? [];
    if (live.includes(record.condition as StackAlertCondition)) continue;
    await db
      .update(stackAlerts)
      .set({ clearedAt: now, updatedAt: now })
      .where(eq(stackAlerts.id, record.id));
    result.cleared.push({
      stackId: record.stackId,
      condition: record.condition as StackAlertCondition,
    });
  }

  const byStack = new Map(rows.map((row) => [row.id, row]));
  for (const [stackId, conditions] of firing) {
    const row = byStack.get(stackId);
    if (!row) continue;

    const fresh: StackAlertCondition[] = [];
    for (const condition of conditions) {
      const record = remembered.find(
        (r) => r.stackId === stackId && r.condition === condition,
      );
      const changed = record?.fingerprint !== fingerprint(condition, row);
      const recurred = record !== undefined && record.clearedAt !== null;
      const cooledDown =
        record !== undefined &&
        now.getTime() - record.lastAlertedAt.getTime() >= cooldownMs;
      if (!record || changed || recurred || cooledDown) fresh.push(condition);
      else result.suppressed += 1;
    }
    if (fresh.length === 0) continue;

    const facts: StackAlertFacts = {
      stackId,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      environmentName: row.environmentName,
      status: row.status,
      since: row.updatedAt,
      now,
      retryCount: row.retryCount,
      attemptCeiling,
      lastError: row.lastError,
      conditions: fresh,
    };

    // One message per STACK rather than per condition: an operator woken twice
    // about the same stack learns to filter, and the conditions overlap by
    // design. The dedupe RECORD stays per condition, so a second condition
    // firing later still gets its own line.
    try {
      await sender.send({
        to,
        subject: stackAlertSubject(facts),
        text: stackAlertBody(facts),
      });
    } catch (error) {
      // Deliberately NOT recorded: an unsent notice must stay unsaid, or a
      // transport blip would silence the condition for a whole cooldown. One
      // failing stack never fails the sweep — the rest still get their notice.
      console.error(
        `[cloud:alert-sweep] send failed for stack=${stackId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      result.failed.push(stackId);
      continue;
    }

    for (const condition of fresh) {
      const signature = fingerprint(condition, row);
      await db
        .insert(stackAlerts)
        .values({
          stackId,
          organizationId: row.organizationId,
          condition,
          fingerprint: signature,
          lastAlertedAt: now,
        })
        .onConflictDoUpdate({
          target: [stackAlerts.stackId, stackAlerts.condition],
          set: {
            fingerprint: signature,
            lastAlertedAt: now,
            // Cleared on purpose: this row is the memory of a condition that is
            // matching NOW, and leaving a clear stamp on it would make the very
            // next tick read it as a recurrence and alert again.
            clearedAt: null,
            updatedAt: now,
          },
        });
    }

    result.alerted.push({ stackId, conditions: fresh });
  }

  return result;
}
