import { postToHogsendApi } from "@/lib/hogsend-api";

/**
 * Server-side read of the customer's services (plan + live subscription
 * state) from the Hono API's `POST /me/services` (see lib/hogsend-api for the
 * wire + secret-scope notes; its `server-only` guard covers this module too).
 *
 * Null means "couldn't load" (unconfigured env, network, upstream error) —
 * the portal renders a soft retry state, never a hard failure. Upstream
 * entries are sanitized per-element (the API deploys independently, so a
 * shape drift must degrade, not crash the page): entries without a valid
 * plan + purchase date are dropped, and malformed optional fields are
 * stripped rather than passed through to Date/Intl formatting.
 */

export type PortalService = {
  plan: string;
  kind: "subscription" | "one_time";
  /** ISO timestamp of the purchase. */
  purchasedAt: string;
  /** Stripe subscription status, "paid" for one-time, "unknown" on a miss. */
  status?: string;
  /** ISO date the current period ends (renewal or cancellation date). */
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  /** The subscription handle for cancel/resume (subscriptions only). */
  subscriptionId?: string;
};

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

function sanitize(entry: unknown): PortalService | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const plan = typeof e.plan === "string" && e.plan ? e.plan : undefined;
  const purchasedAt = isoOrUndefined(e.purchasedAt);
  if (!plan || !purchasedAt) return null;
  return {
    plan,
    kind: e.kind === "subscription" ? "subscription" : "one_time",
    purchasedAt,
    status: typeof e.status === "string" ? e.status : undefined,
    currentPeriodEnd: isoOrUndefined(e.currentPeriodEnd),
    cancelAtPeriodEnd:
      typeof e.cancelAtPeriodEnd === "boolean"
        ? e.cancelAtPeriodEnd
        : undefined,
    subscriptionId:
      typeof e.subscriptionId === "string" ? e.subscriptionId : undefined,
  };
}

export async function fetchServices(input: {
  email: string;
  userId?: string;
}): Promise<PortalService[] | null> {
  const data = await postToHogsendApi<{ services?: unknown }>(
    "/me/services",
    input,
  );
  if (!data || !Array.isArray(data.services)) return null;
  return data.services
    .map(sanitize)
    .filter((s): s is PortalService => s !== null);
}
