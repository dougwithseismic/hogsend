import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, organizations, sesTenants } from "../db/schema";
import {
  readRelayEmailsForDay,
  readRelayEmailsInWindow,
} from "../services/email-usage";
import type { CloudPlan } from "../services/orgs";
import { planLimits } from "../services/plan-limits";
import {
  type EmailTrustTier,
  type TierCapWindow,
  tierSendCap,
} from "./email-abuse-policy";

/**
 * THE TIER SEND CAP (PRD 08 task 5).
 *
 * A SEPARATE gate from the plan allowance, sitting immediately before it in the
 * relay's pre-send path, and the separation is the point:
 *
 *  - the **allowance** is a billing ceiling. It has overage, it has a hard cap,
 *    it answers 402, and a customer can raise it by paying;
 *  - the **tier cap** is an abuse control. It answers 403, no amount of money
 *    lifts it, and the only way past it is a sending record.
 *
 * Merging them would mean one number doing two jobs, and the first time a
 * `watched` tenant upgraded their plan the abuse control would quietly widen.
 *
 * The cap is a CHECK, never a consume. It reads the same counter the post-wire
 * meter writes, so a refused request, a replayed idempotency key and a send
 * that failed at the wire all cost nothing against it — otherwise a retry storm
 * would eat a tenant's daily budget without a message leaving the building.
 */

export interface TierCapRefusal {
  allowed: false;
  reason: "tier_cap_exceeded";
  tier: EmailTrustTier;
  window: TierCapWindow;
  limit: number;
  used: number;
}

export type TierCapVerdict = { allowed: true } | TierCapRefusal;

export interface TierCapInput {
  environmentId: string;
  organizationId: string;
  /** How many messages this request wants. The WHOLE request is weighed. */
  count: number;
  now?: Date;
  db?: CloudDb;
}

/**
 * May these `count` messages go, given the tenant's tier?
 *
 * **A missing SES tenancy is NOT capped, and that is a deliberate answer rather
 * than an oversight.** The tier cap exists to bound the damage ONE SES TENANT
 * can do to the pool we all share. An environment with no `ses_tenants` row has
 * no tenant in our AWS account to damage it with — a send on its behalf is
 * refused by SES itself, because the tenant it names does not exist — so a cap
 * here would be guarding a door that is not there.
 *
 * Nothing real escapes through it: `provisionSesTenant` writes the tenancy row
 * and mints the relay token in ONE transaction, and the teardown deletes them
 * together, so every environment that can reach this relay at all has a row and
 * therefore a tier. Reading the row (rather than `readTrustTier`, which answers
 * `new` for an absent one) is what keeps "no tenancy" and "the most restrictive
 * tier" distinguishable here, where they mean different things.
 *
 * It also fails open on an organization it cannot read, for the narrower
 * reason: with no plan the `watched` cap has no percentage to take, and the
 * relay's own inner join has already excluded that state.
 *
 * ONE query for both, because this is the send path: the tier and the plan are
 * always wanted together, and two round trips per message to assemble one
 * decision is a cost paid on every send forever.
 */
export async function checkTierSendCap(
  input: TierCapInput,
): Promise<TierCapVerdict> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();

  const [row] = await db
    .select({
      trustTier: sesTenants.trustTier,
      plan: organizations.plan,
      createdAt: organizations.createdAt,
    })
    .from(sesTenants)
    .innerJoin(environments, eq(environments.id, sesTenants.environmentId))
    .innerJoin(organizations, eq(organizations.id, environments.organizationId))
    .where(eq(sesTenants.environmentId, input.environmentId))
    .limit(1);
  // No tenancy (see above), or an environment whose organization vanished
  // mid-request — a state the relay's own inner join has already excluded.
  if (!row) return { allowed: true };

  const tier = row.trustTier;
  const plan = row.plan as CloudPlan;
  const cap = tierSendCap({
    tier,
    planAllowance: planLimits(plan).emailsPerMonth,
  });
  // `established` has no tier cap; the allowance gate is the only ceiling.
  if (!cap) return { allowed: true };

  const used =
    cap.window === "day"
      ? await readRelayEmailsForDay(
          { environmentId: input.environmentId, at: now },
          db,
        )
      : await readRelayEmailsInWindow(
          { id: input.organizationId, plan, createdAt: row.createdAt },
          now,
          db,
        );

  // The whole request is weighed: admitting a batch of fifty into thirty
  // remaining is the failure a per-message check would produce.
  if (used + input.count <= cap.limit) return { allowed: true };
  return {
    allowed: false,
    reason: "tier_cap_exceeded",
    tier,
    window: cap.window,
    limit: cap.limit,
    used,
  };
}

/**
 * The refusal, as a sentence a journey can record.
 *
 * It names the tier, the number, and the way out, because "not allowed" in a
 * journey's failure log costs a support conversation.
 */
export function tierCapMessage(refusal: TierCapRefusal): string {
  const period = refusal.window === "day" ? "day" : "billing period";
  const route =
    refusal.tier === "watched"
      ? "The cap is lifted by a human review once the reputation findings against this environment are resolved."
      : "The cap is lifted automatically once this environment has an established sending record.";
  return `This environment is on the ${refusal.tier} trust tier, which may send ${refusal.limit} messages per ${period}; ${refusal.used} have been sent. Nothing was sent and nothing was queued. ${route}`;
}
