import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { BillingEvent } from "../billing/types";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { organizations } from "../db/schema";
import { writeAudit } from "./audit";
import type { OrganizationRow, SuspensionReason } from "./orgs";
import { type CloudPlan, OrgService, PLAN_ENVIRONMENT_LIMITS } from "./orgs";

/**
 * Billing state, applied to the tenant root.
 *
 * This service is the ONLY writer of `organizations.plan`, `dunning_since` and
 * `billing_customer_id`, and the only caller that suspends an org for a billing
 * reason. Its rules:
 *
 *  - a webhook is a FACT about the outside world, not a command. Every branch
 *    is idempotent, because a provider re-delivers (Stripe retries for days)
 *    and a duplicate must be a no-op rather than a second charge of state: a
 *    plan already applied writes nothing, a dunning clock already running is
 *    not restarted, an already-suspended org is not re-suspended.
 *  - the grace clock is measured from the FIRST failure. A later failure that
 *    overwrote `dunning_since` would hand a non-paying tenant an unbounded
 *    runway, one retry at a time.
 *  - a cancellation suspends but does NOT rewrite the plan. Suspension stops
 *    the stack and keeps the data (DECISIONS §2); the plan is the record of
 *    what the tenant bought, and a suspended tenant's limits are moot anyway.
 *  - unsuspension is NARROW, and narrow by the RECORDED REASON: a stop this
 *    service wrote (`suspended_reason = billing`) is lifted the moment the
 *    subscription is in good standing again — a cancelled tenant who
 *    re-subscribes must not keep paying for a stopped stack — while an ops or
 *    abuse suspension carries a different reason and no invoice can lift it.
 *  - every transition is audit-logged, in the SAME transaction as the write it
 *    describes.
 */

/** DECISIONS §2, as data. PRD 06 task 3 (metering + enforcement) consumes it. */
export interface PlanLimits {
  /** Environments, including production. */
  environments: number;
  /**
   * Ingested events per calendar month. For `trial` this is the TOTAL for the
   * whole 14 days rather than a monthly allowance — a trial never sees a second
   * month, so one field carries both meanings without ambiguity.
   */
  eventsPerMonth: number;
  /** Emails sent per calendar month; same trial caveat as `eventsPerMonth`. */
  emailsPerMonth: number;
}

/**
 * The tier table from DECISIONS §2. The environment counts are NOT restated
 * here — they are read off `PLAN_ENVIRONMENT_LIMITS`, which the environment
 * service already enforces, so the two can never drift into disagreeing about
 * what a plan allows.
 */
export const PLAN_LIMITS = {
  trial: {
    environments: PLAN_ENVIRONMENT_LIMITS.trial,
    eventsPerMonth: 10_000,
    emailsPerMonth: 1_000,
  },
  self_serve: {
    environments: PLAN_ENVIRONMENT_LIMITS.self_serve,
    eventsPerMonth: 100_000,
    emailsPerMonth: 10_000,
  },
  dedicated: {
    environments: PLAN_ENVIRONMENT_LIMITS.dedicated,
    eventsPerMonth: 1_000_000,
    emailsPerMonth: 100_000,
  },
} as const satisfies Record<CloudPlan, PlanLimits>;

export function planLimits(plan: CloudPlan): PlanLimits {
  return PLAN_LIMITS[plan];
}

/** DECISIONS/PRD 06: 14 days from the first failed payment to suspension. */
export const DUNNING_GRACE_DAYS = 14;

/** The reason this service stamps on every suspension it writes — and the only
 * one it will lift. */
const BILLING_SUSPENSION: SuspensionReason = "billing";

const DAY_MS = 86_400_000;

export interface ApplyBillingEventResult {
  /** False when the event names an organization this control plane does not
   * have — a webhook for a deleted tenant, or another environment's Stripe
   * account pointed at this URL. */
  applied: boolean;
  organization?: OrganizationRow;
  planChanged: boolean;
  /** The audit actions written, so a caller (and a test) can see what a
   * transition actually did without re-reading the log. */
  actions: string[];
}

export interface EnforceDunningResult {
  /** Organization ids suspended by this sweep. */
  suspended: string[];
}

export class PlanService {
  private readonly orgs: OrgService;

  constructor(private readonly db: CloudDb = defaultDb) {
    this.orgs = new OrgService(db);
  }

  /**
   * Apply one verified billing event. The route calls this and nothing else, so
   * "what a webhook may do to a tenant" is exactly this method's surface.
   */
  async applyBillingEvent(
    event: BillingEvent,
    options: { actor?: string; now?: Date } = {},
  ): Promise<ApplyBillingEventResult> {
    const actor = options.actor ?? "billing";
    const now = options.now ?? new Date();

    const organization = await this.read(event.organizationId);
    if (!organization) {
      // Not an error the provider can fix by retrying. The route answers 200.
      return { applied: false, planChanged: false, actions: [] };
    }

    switch (event.type) {
      case "checkout_completed":
      case "subscription_updated":
        return this.applyGoodStanding(organization, event, actor, now);
      case "payment_failed":
        return this.applyPaymentFailure(organization, event, actor, now);
      case "subscription_canceled":
        return this.applyCancellation(organization, event, actor);
    }
  }

  /**
   * The grace enforcer, driven by the nightly cloud-worker sweep (PRD 06 task
   * 3). Split from `applyBillingEvent` because nothing in the provider's event
   * stream marks the moment a grace period ENDS — only the clock does.
   */
  async enforceDunningGrace(
    options: { now?: Date; actor?: string } = {},
  ): Promise<EnforceDunningResult> {
    const now = options.now ?? new Date();
    const actor = options.actor ?? "billing";
    const cutoff = new Date(now.getTime() - DUNNING_GRACE_DAYS * DAY_MS);

    const expired = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          isNotNull(organizations.dunningSince),
          lte(organizations.dunningSince, cutoff),
          // Already-suspended orgs are done: re-suspending would write a second
          // `org.suspended` row and move `suspended_at` forward every night.
          isNull(organizations.suspendedAt),
        ),
      );

    const suspended: string[] = [];
    for (const { id } of expired) {
      await writeAudit(this.db, {
        actor,
        organizationId: id,
        action: "billing.dunning_expired",
        subject: id,
        detail: { graceDays: DUNNING_GRACE_DAYS },
      });
      // `dunning_since` is deliberately LEFT SET: the grace that expired is
      // part of the record, and `suspended_reason` is what marks the stop as a
      // billing one and so what lets a later payment lift it.
      await this.orgs.suspend({ id, actor, reason: BILLING_SUSPENSION });
      suspended.push(id);
    }

    return { suspended };
  }

  /** Stop the grace clock. Idempotent; writes nothing if it was not running. */
  async clearDunning(input: {
    organizationId: string;
    actor?: string;
  }): Promise<{ cleared: boolean }> {
    const organization = await this.read(input.organizationId);
    if (!organization?.dunningSince) return { cleared: false };

    const actions = await this.recover(
      organization,
      input.actor ?? "billing",
      {},
    );
    return { cleared: actions.length > 0 };
  }

  /**
   * A completed checkout or a healthy subscription: adopt the plan it names
   * (when it names one) and end any dunning.
   */
  private async applyGoodStanding(
    organization: OrganizationRow,
    event: BillingEvent,
    actor: string,
    now: Date,
  ): Promise<ApplyBillingEventResult> {
    const actions: string[] = [];
    const planChanged = event.plan !== null && event.plan !== organization.plan;

    if (planChanged || carriesNewCustomer(organization, event)) {
      const updated = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(organizations)
          .set({
            ...(planChanged ? { plan: event.plan as CloudPlan } : {}),
            // The 14-day clock belonged to the trial alone; a paying org must
            // not carry an expiry that a trial sweep would act on.
            ...(planChanged && event.plan !== null
              ? { trialEndsAt: null }
              : {}),
            ...(carriesNewCustomer(organization, event)
              ? { billingCustomerId: event.customerRef }
              : {}),
            updatedAt: now,
          })
          .where(eq(organizations.id, organization.id))
          .returning();

        if (planChanged) {
          await writeAudit(tx, {
            actor,
            organizationId: organization.id,
            action: "billing.plan_changed",
            subject: organization.id,
            detail: {
              from: organization.plan,
              to: event.plan,
              eventId: event.eventId,
              eventType: event.type,
            },
          });
          actions.push("billing.plan_changed");

          if (event.plan === "dedicated") {
            // The plan is sold and billed NOW; the topology move (private
            // Postgres + private Hatchet, DECISIONS §2) is PRD 11's. Recording
            // the debt beats a silent gap between what the tenant pays for and
            // what they run on.
            await writeAudit(tx, {
              actor,
              organizationId: organization.id,
              action: "billing.reprovision_deferred",
              subject: organization.id,
              detail: {
                reason:
                  "dedicated topology re-provision is deferred to PRD 11; the org keeps its shared-cell stacks until then",
                eventId: event.eventId,
              },
            });
            actions.push("billing.reprovision_deferred");
          }
        }
        return row;
      });

      actions.push(
        ...(await this.recover(updated ?? organization, actor, { now })),
      );
      return {
        applied: true,
        ...(updated ? { organization: updated } : {}),
        planChanged,
        actions,
      };
    }

    actions.push(...(await this.recover(organization, actor, { now })));
    return { applied: true, organization, planChanged: false, actions };
  }

  /**
   * End dunning, and lift a suspension this service caused. Returns the audit
   * actions it wrote so callers can report a full transition.
   *
   * The two halves are INDEPENDENT on purpose. A cancellation suspends with no
   * dunning clock running (`applyCancellation` clears it), so gating the
   * unsuspend on `dunning_since` would make a cancelled tenant's re-subscription
   * pay for a stack that stays stopped — the money moves and nothing comes back.
   */
  private async recover(
    organization: OrganizationRow,
    actor: string,
    options: { now?: Date },
  ): Promise<string[]> {
    const actions: string[] = [];

    const dunningSince = organization.dunningSince;
    if (dunningSince) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(organizations)
          .set({ dunningSince: null, updatedAt: options.now ?? new Date() })
          .where(eq(organizations.id, organization.id));
        await writeAudit(tx, {
          actor,
          organizationId: organization.id,
          action: "billing.dunning_cleared",
          subject: organization.id,
          detail: { dunningSince: dunningSince.toISOString() },
        });
      });
      actions.push("billing.dunning_cleared");
    }

    // NARROW by design, and now narrow by DATA rather than by proxy: only a
    // suspension this service wrote (`reason = billing`) is lifted by a
    // payment. An ops/abuse stop carries a different reason and stays put.
    if (
      organization.suspendedAt &&
      organization.suspendedReason === BILLING_SUSPENSION
    ) {
      await this.orgs.unsuspend({ id: organization.id, actor });
      actions.push("org.unsuspended");
    }
    return actions;
  }

  /** A failed charge. Records the fact every time; starts the clock once. */
  private async applyPaymentFailure(
    organization: OrganizationRow,
    event: BillingEvent,
    actor: string,
    now: Date,
  ): Promise<ApplyBillingEventResult> {
    const starting = organization.dunningSince === null;
    const actions: string[] = [];

    const updated = await this.db.transaction(async (tx) => {
      await writeAudit(tx, {
        actor,
        organizationId: organization.id,
        action: "billing.payment_failed",
        subject: organization.id,
        detail: {
          eventId: event.eventId,
          // The clock as it stands AFTER this event — the grace a reader of the
          // log needs to know about.
          dunningSince: (starting
            ? now
            : organization.dunningSince
          )?.toISOString(),
        },
      });
      actions.push("billing.payment_failed");

      if (!starting) return organization;

      const [row] = await tx
        .update(organizations)
        .set({ dunningSince: now, updatedAt: now })
        // Guarded: two failures delivered concurrently would otherwise both
        // read null and the second would move the clock forward.
        .where(
          and(
            eq(organizations.id, organization.id),
            isNull(organizations.dunningSince),
          ),
        )
        .returning();
      if (!row) return organization;

      await writeAudit(tx, {
        actor,
        organizationId: organization.id,
        action: "billing.dunning_started",
        subject: organization.id,
        detail: {
          graceDays: DUNNING_GRACE_DAYS,
          suspendsAt: new Date(
            now.getTime() + DUNNING_GRACE_DAYS * DAY_MS,
          ).toISOString(),
          eventId: event.eventId,
        },
      });
      actions.push("billing.dunning_started");
      return row;
    });

    return {
      applied: true,
      organization: updated,
      planChanged: false,
      actions,
    };
  }

  /** The subscription is over: stop the stack, keep the data. */
  private async applyCancellation(
    organization: OrganizationRow,
    event: BillingEvent,
    actor: string,
  ): Promise<ApplyBillingEventResult> {
    if (organization.suspendedAt) {
      // Already stopped. A re-delivered cancellation must not move
      // `suspended_at` forward or write a second suspension.
      return { applied: true, organization, planChanged: false, actions: [] };
    }

    await this.db.transaction(async (tx) => {
      // The grace clock (if any) ended in a cancellation, not a recovery.
      await tx
        .update(organizations)
        .set({ dunningSince: null, updatedAt: new Date() })
        .where(eq(organizations.id, organization.id));
      await writeAudit(tx, {
        actor,
        organizationId: organization.id,
        action: "billing.subscription_canceled",
        subject: organization.id,
        detail: { eventId: event.eventId, plan: organization.plan },
      });
    });

    const { organization: suspended } = await this.orgs.suspend({
      id: organization.id,
      actor,
      // Marked as OURS, so a re-subscription lifts it. Without the reason a
      // cancelled tenant who paid again would keep a stopped stack forever:
      // `recover()` has no other way to tell this stop from an abuse one.
      reason: BILLING_SUSPENSION,
    });

    return {
      applied: true,
      organization: suspended,
      planChanged: false,
      actions: ["billing.subscription_canceled", "org.suspended"],
    };
  }

  /**
   * Note that an UNVERIFIED payload was refused.
   *
   * Deliberately best-effort, and deliberately narrow. The audit table is
   * organization-scoped (`organization_id NOT NULL`, FK), so a rejection can
   * only be recorded against a tenant that actually exists — and the only org
   * id available here comes from a payload we just refused to trust. So: read a
   * candidate out of it, and write the row ONLY if that candidate names a real
   * organization. Anything else (a forged id, a random probe) is dropped
   * rather than turned into attacker-authored audit rows or an FK violation
   * that would turn a clean 400 into a 500.
   *
   * `verified: false` is on the row itself so nobody later mistakes it for a
   * fact about the tenant.
   */
  async recordWebhookRejection(input: {
    payload: string;
    reason: string;
    actor?: string;
  }): Promise<{ recorded: boolean }> {
    const candidate = findOrganizationId(input.payload);
    if (!candidate) return { recorded: false };

    const organization = await this.read(candidate);
    if (!organization) return { recorded: false };

    await writeAudit(this.db, {
      actor: input.actor ?? "billing",
      organizationId: organization.id,
      action: "billing.webhook_rejected",
      subject: organization.id,
      // The REASON only. Never the payload: it is untrusted input, and a
      // billing webhook body carries customer identifiers.
      detail: { reason: input.reason, verified: false },
    });
    return { recorded: true };
  }

  private async read(id: string): Promise<OrganizationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    return row;
  }
}

/**
 * The provider's customer handle for an org, or undefined. Injected into
 * `StripeBilling` by the billing factory so the provider itself stays
 * database-free.
 */
export async function getBillingCustomerId(
  organizationId: string,
  database: CloudDb = defaultDb,
): Promise<string | undefined> {
  const [row] = await database
    .select({ customerId: organizations.billingCustomerId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.customerId ?? undefined;
}

/** Keys any provider might carry an organization id under. Provider-neutral on
 * purpose: this runs BEFORE (and independently of) any provider parse. */
const ORGANIZATION_ID_KEYS = new Set(["organizationId", "client_reference_id"]);

/** Bounded so a hostile payload cannot make this walk forever. */
const MAX_SEARCH_DEPTH = 8;

/**
 * Find an organization id anywhere in an untrusted payload. The result is a
 * CANDIDATE, never a fact — the caller must confirm it against a real row
 * before acting on it in any way.
 */
function findOrganizationId(payload: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }

  const walk = (value: unknown, depth: number): string | undefined => {
    if (
      depth > MAX_SEARCH_DEPTH ||
      typeof value !== "object" ||
      value === null
    ) {
      return undefined;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        ORGANIZATION_ID_KEYS.has(key) &&
        typeof child === "string" &&
        child.length > 0
      ) {
        return child;
      }
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };

  return walk(parsed, 0);
}

function carriesNewCustomer(
  organization: OrganizationRow,
  event: BillingEvent,
): boolean {
  return (
    typeof event.customerRef === "string" &&
    event.customerRef.length > 0 &&
    event.customerRef !== organization.billingCustomerId
  );
}

/** Default instance bound to the app pool — the usual import for callers. */
export const planService = new PlanService();
