/**
 * Server-side read of the customer's services (plan + live subscription
 * state) from the Hono API's `POST /me/services` — the same shared-bearer
 * wire as /api/checkout. The docs holds no Stripe secret and no engine DB
 * connection; the API resolves the purchases and reads live billing state
 * from Stripe. Server-only (the bearer never reaches the client): only ever
 * call this from a server component/route with a session-verified email.
 *
 * Null means "couldn't load" (unconfigured env, network, upstream error) —
 * the portal renders a soft retry state, never a hard failure.
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
};

export async function fetchServices(input: {
  email: string;
  userId?: string;
}): Promise<PortalService[] | null> {
  const base = process.env.HOGSEND_INGEST_URL;
  const secret = process.env.SERVICE_CHECKOUT_SECRET;
  if (!base || !secret) return null;

  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/me/services`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      services?: unknown;
    } | null;
    return Array.isArray(data?.services)
      ? (data.services as PortalService[])
      : null;
  } catch {
    return null;
  }
}
