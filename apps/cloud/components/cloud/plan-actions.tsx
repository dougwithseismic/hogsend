import type { JSX } from "react";
import { Button } from "@/components/ds/button";
import { cn } from "@/lib/cn";
import { PLAN_CATALOG, upgradesFrom } from "@/src/lib/plan-catalog";
import type { CloudPlan } from "@/src/services/orgs";

/**
 * The upgrade and manage-billing controls.
 *
 * Plain HTML forms posting to route handlers that answer 303 — no client
 * component, no `useActionState`, no JavaScript. A checkout is a navigation
 * away from this app, so the browser's own form POST is exactly the right
 * mechanism and adding a client boundary would buy a spinner and cost a bundle.
 *
 * Both destinations are minted per request (a checkout session, a portal
 * session), which is also why "Manage billing" is a POST rather than a link:
 * there is no URL to put in an `href` at render time.
 *
 * The buttons are hidden from a plain member because there is nothing behind
 * them for that caller — the routes refuse the same call, and THAT is the
 * enforcement (`lib/billing-route.ts`); this is only the no-dead-buttons rule.
 */

type PlanActionsProps = {
  plan: CloudPlan;
  /** Owner/admin. False renders nothing at all. */
  canManage: boolean;
  /** Set once a checkout has completed — what the portal opens against. */
  billingCustomerId: string | null;
  className?: string;
};

export function PlanActions({
  plan,
  canManage,
  billingCustomerId,
  className,
}: PlanActionsProps): JSX.Element | null {
  if (!canManage) return null;

  const upgrades = upgradesFrom(plan);
  if (upgrades.length === 0 && !billingCustomerId) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      {upgrades.map((target) => (
        <form key={target} method="post" action="/api/billing/checkout">
          <input type="hidden" name="plan" value={target} />
          <Button type="submit" variant="outline">
            {`Upgrade to ${PLAN_CATALOG[target].label} — ${PLAN_CATALOG[target].price}`}
          </Button>
        </form>
      ))}
      {billingCustomerId ? (
        <form method="post" action="/api/billing/portal">
          <Button type="submit" variant="ghost">
            Manage billing
          </Button>
        </form>
      ) : null}
    </div>
  );
}
