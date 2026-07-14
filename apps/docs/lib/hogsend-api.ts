import "server-only";

/**
 * The shared-bearer wire to the Hono API (checkout, portal, billing): POST
 * JSON to `${HOGSEND_INGEST_URL}<path>` authorized with
 * `SERVICE_CHECKOUT_SECRET`. One place for the env reads, URL normalization,
 * timeout, and defensive parse — every caller gets the same fail-soft
 * contract (null on unconfigured env, network failure, non-OK status, or
 * unparseable body).
 *
 * `import "server-only"` makes any client-component import a BUILD error —
 * the bearer must never reach the browser bundle.
 *
 * NOTE the bearer's scope: it authorizes checkout-session creation AND
 * customer-scoped billing reads/operations on the API. Treat it as
 * high-value; rotate (both services) on any suspicion of exposure.
 */
export async function postToHogsendApi<T>(
  path: string,
  body: unknown,
): Promise<T | null> {
  const res = await postToHogsendApiRaw(path, body);
  return res?.ok ? (res.data as T | null) : null;
}

/**
 * Status-preserving variant for the billing ACTION routes, which must relay
 * upstream verdicts (409 "not modifiable", 401 ownership) rather than
 * flatten everything to null. Null still means unconfigured env / network
 * failure / timeout.
 */
export async function postToHogsendApiRaw(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown } | null> {
  const base = process.env.HOGSEND_INGEST_URL;
  const secret = process.env.SERVICE_CHECKOUT_SECRET;
  if (!base || !secret) return null;

  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    return {
      ok: res.ok,
      status: res.status,
      data: await res.json().catch(() => null),
    };
  } catch {
    return null;
  }
}
