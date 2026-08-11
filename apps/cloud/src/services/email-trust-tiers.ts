import { and, count, eq, gte } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  emailEvents,
  emailFindings,
  environments,
  sesTenants,
} from "../db/schema";
import {
  EMPTY_TRUST_TIER_STATS,
  type EmailTrustTier,
  REPUTATION_WINDOW_DAYS,
  type TrustTierStats,
  tierReputationPolicy,
} from "../lib/email-abuse-policy";
import type { SesClient } from "../ses/contract";
import { getSesClient } from "../ses/index";
import type { SesReputationPolicy } from "../ses/types";
import { writeAudit } from "./audit";
import { readRelaySendingWindow } from "./email-usage";

/**
 * THE TIER ENGINE'S EFFECTFUL HALF (PRD 08 task 4).
 *
 * The RULES live in `lib/email-abuse-policy.ts` and are pure. This module is
 * what turns a decision into the two writes that make it real — the tier
 * column, and the SES reputation policy the tier means — plus the reads the
 * rules are judged over.
 *
 * The split is not ceremony. It is what lets the whole policy be tested against
 * values, and what keeps the number of places that can call AWS down to one.
 *
 * Two invariants hold across everything here:
 *
 *  - **`ses_tenants.trust_tier` and `ses_tenants.reputation_policy` are written
 *    together or not at all.** They are two statements of one decision; a tenant
 *    recorded as `watched` while SES still enforces `NONE` is a tenant we
 *    believe is contained and is not.
 *  - **A missing tenancy row reads as `new`.** It is the most restrictive tier,
 *    so an environment in a torn state is bounded rather than unbounded.
 */

/** The actor recorded when a caller does not name one. */
const DEFAULT_ACTOR = "reputation";

export const TRUST_TIER_CHANGED_ACTION = "email_trust_tier.changed";

/**
 * This environment's tier.
 *
 * `new` for an environment with no SES tenancy — see the module note. It is a
 * read the relay makes on the hot path, so it selects one column off an index.
 */
export async function readTrustTier(input: {
  environmentId: string;
  db?: CloudDb;
}): Promise<EmailTrustTier> {
  const db = input.db ?? defaultDb;
  const [row] = await db
    .select({ trustTier: sesTenants.trustTier })
    .from(sesTenants)
    .where(eq(sesTenants.environmentId, input.environmentId))
    .limit(1);
  return row?.trustTier ?? "new";
}

/** How many findings are open against this environment right now. */
export async function countOpenFindings(input: {
  environmentId: string;
  db?: CloudDb;
}): Promise<number> {
  const db = input.db ?? defaultDb;
  const [row] = await db
    .select({ open: count(emailFindings.id) })
    .from(emailFindings)
    .where(
      and(
        eq(emailFindings.environmentId, input.environmentId),
        eq(emailFindings.status, "open"),
      ),
    );
  return Number(row?.open ?? 0);
}

export interface ApplyTrustTierResult {
  changed: boolean;
  tier: EmailTrustTier;
  policy: SesReputationPolicy;
}

/**
 * Move this environment to `tier`, and make SES enforce what the tier means.
 *
 * Ordered SES-first, database-second, and that order is the safe one: if the
 * AWS call fails the write does not happen and the next sweep retries the whole
 * transition, whereas a database-first order would record a containment that
 * was never applied. A no-op transition makes NO AWS call at all — re-asserting
 * a policy on every sweep tick would spend a rate-limited API call per tenant
 * per tick to change nothing.
 */
export async function applyTrustTier(input: {
  environmentId: string;
  tier: EmailTrustTier;
  /** Why, in a sentence. Lands in the audit row. */
  reason: string;
  actor?: string;
  db?: CloudDb;
  ses?: SesClient;
}): Promise<ApplyTrustTierResult> {
  const db = input.db ?? defaultDb;
  const policy = tierReputationPolicy(input.tier);

  const [row] = await db
    .select({
      tenantName: sesTenants.tenantName,
      trustTier: sesTenants.trustTier,
      region: sesTenants.region,
      organizationId: environments.organizationId,
    })
    .from(sesTenants)
    .innerJoin(environments, eq(environments.id, sesTenants.environmentId))
    .where(eq(sesTenants.environmentId, input.environmentId))
    .limit(1);

  // No tenancy: nothing in AWS to enforce against and no column to write. Not
  // an error — an environment that never provisioned Hogsend Email cannot be
  // in a tier, and the reader already answers `new` for it.
  if (!row) return { changed: false, tier: "new", policy: "NONE" };
  if (row.trustTier === input.tier) {
    return { changed: false, tier: input.tier, policy };
  }

  const ses = input.ses ?? getSesClient(row.region);
  await ses.setReputationPolicy({ tenantName: row.tenantName, policy });

  await db.transaction(async (tx) => {
    await tx
      .update(sesTenants)
      .set({
        trustTier: input.tier,
        reputationPolicy: policy,
        updatedAt: new Date(),
      })
      .where(eq(sesTenants.environmentId, input.environmentId));
    await writeAudit(tx, {
      actor: input.actor ?? DEFAULT_ACTOR,
      organizationId: row.organizationId,
      action: TRUST_TIER_CHANGED_ACTION,
      subject: input.environmentId,
      detail: {
        from: row.trustTier,
        to: input.tier,
        policy,
        reason: input.reason,
      },
    });
  });

  return { changed: true, tier: input.tier, policy };
}

export type ManualTierResult =
  | { ok: true; tier: EmailTrustTier }
  | {
      ok: false;
      reason: "open_findings" | "no_tenancy";
      message: string;
    };

/**
 * A HUMAN moving a tenant's tier — the only way out of `watched`.
 *
 * There is no route and no Studio button behind this, deliberately. Appeals are
 * a human queue (AUP §6.6) and a button is an automatic bypass wearing a UI, so
 * the lever is a function an operator calls with an actor recorded against it.
 *
 * The one guard: promotion out of `watched` is REFUSED while a finding is open.
 * Not paternalism — the tier engine demotes on any open finding, so a promotion
 * granted over one would be reversed by the next sweep, and the customer would
 * be told twice that they were let back on and stopped again. §6.6's rule that
 * reinstatement "requires the cause to be resolved" is the same rule.
 */
export async function manuallySetTrustTier(input: {
  environmentId: string;
  tier: EmailTrustTier;
  /** WHO. An audited manual override with no actor is not auditable. */
  actor: string;
  reason?: string;
  db?: CloudDb;
  ses?: SesClient;
}): Promise<ManualTierResult> {
  const db = input.db ?? defaultDb;
  const current = await readTrustTier({
    environmentId: input.environmentId,
    db,
  });

  if (current === "watched" && input.tier !== "watched") {
    const open = await countOpenFindings({
      environmentId: input.environmentId,
      db,
    });
    if (open > 0) {
      return {
        ok: false,
        reason: "open_findings",
        message: `This environment has ${open} open reputation finding(s). Promotion out of watched requires the cause to be resolved first (AUP §6.6); a promotion granted now would be reversed by the next reputation sweep.`,
      };
    }
  }

  const applied = await applyTrustTier({
    environmentId: input.environmentId,
    tier: input.tier,
    reason: input.reason ?? `manual review by ${input.actor}`,
    actor: input.actor,
    db,
    ...(input.ses ? { ses: input.ses } : {}),
  });

  // `applyTrustTier` answers `new` with no change when there is no tenancy;
  // saying "done" there would report a promotion that did not happen.
  if (!applied.changed && applied.tier !== input.tier) {
    return {
      ok: false,
      reason: "no_tenancy",
      message:
        "That environment has no Hogsend Email tenancy, so it has no trust tier to set.",
    };
  }

  return { ok: true, tier: applied.tier };
}

/**
 * One tenant's recent sending, as the rules need it.
 *
 * The window is `REPUTATION_WINDOW_DAYS` back from `now`. Sends come from the
 * relay's own daily counter and the terminal outcomes from `email_events` (PRD
 * 05's record of what SES told us happened), so the denominator is what we
 * ACCEPTED for the wire and the numerators are what the wire reported back —
 * the same shape AWS computes its own rates in.
 */
export async function readTrustTierStats(input: {
  environmentId: string;
  now?: Date;
  windowDays?: number;
  db?: CloudDb;
}): Promise<TrustTierStats> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? REPUTATION_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [window, outcomes] = await Promise.all([
    readRelaySendingWindow({ environmentId: input.environmentId, since }, db),
    db
      .select({ type: emailEvents.type, total: count(emailEvents.id) })
      .from(emailEvents)
      .where(
        and(
          eq(emailEvents.environmentId, input.environmentId),
          gte(emailEvents.occurredAt, since),
        ),
      )
      .groupBy(emailEvents.type),
  ]);

  const byType = new Map(
    outcomes.map((row) => [row.type, Number(row.total ?? 0)]),
  );
  return {
    ...EMPTY_TRUST_TIER_STATS,
    sendingDays: window.sendingDays,
    sent: window.sent,
    delivered: byType.get("email.delivered") ?? 0,
    bounced: byType.get("email.bounced") ?? 0,
    complained: byType.get("email.complained") ?? 0,
  };
}
