import {
  BillingDisabledError,
  BillingError,
  BillingSignatureError,
  getBilling,
} from "@/src/billing";
import { planService } from "@/src/services/billing-plan";

/**
 * The billing provider's webhook endpoint (PRD 06 task 2).
 *
 * Four things this handler owes, in order of how badly each would hurt:
 *
 *  1. FAIL CLOSED. The provider is the only party allowed to change a tenant's
 *     plan from outside, and this URL is public. Verification happens inside
 *     `provider.parseWebhook` — there is no path through the seam that parses
 *     without verifying — and a refusal is a 400 that applied nothing.
 *  2. RAW BODY. `request.text()` is read before anything else and handed over
 *     verbatim. `request.json()` would re-serialise and the HMAC (computed over
 *     the exact bytes Stripe sent) would never match again.
 *  3. NO SESSION. Stripe carries no cookie; the route guard's matcher excludes
 *     `/api` wholesale (`proxy.ts`), which `billing-webhook.test.ts` pins.
 *  4. THE RIGHT STATUS. A provider decides whether to re-deliver from the
 *     status code, so: 400 for anything we will never accept (a bad
 *     signature — retrying cannot fix bytes), 500 for anything a human could
 *     fix (a missing secret, a database that is down), 503 when billing is
 *     switched off for this deployment, 200 for everything applied, ignored or
 *     unattributable.
 *
 * Nothing here logs the payload or a header: a billing webhook body carries
 * customer identifiers, and its signature header is a secret-derived value.
 */

// The verdict depends on live request bytes and live database state; caching or
// prerendering it would be meaningless at best.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const payload = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  let event: Awaited<ReturnType<ReturnType<typeof getBilling>["parseWebhook"]>>;
  try {
    event = await getBilling().parseWebhook({ payload, headers });
  } catch (error) {
    if (error instanceof BillingDisabledError) {
      // No billing is wired here, so nothing about this payload can be trusted
      // OR applied. 503 (not 400) because the bytes were never the problem and
      // a re-delivery after billing is enabled should be accepted.
      return Response.json({ error: error.code }, { status: 503 });
    }
    if (error instanceof BillingSignatureError) {
      // Best-effort note against the org the payload CLAIMS, and only if that
      // org is real. It must never turn the 400 into a 500.
      await planService
        .recordWebhookRejection({ payload, reason: error.code })
        .catch(() => undefined);
      return Response.json({ error: "invalid_signature" }, { status: 400 });
    }
    return failure(error);
  }

  // A verified event outside the lifecycle (or one that names no organization
  // this control plane has) is acknowledged, not retried: the provider cannot
  // fix either by sending it again.
  if (!event) return received();

  try {
    await planService.applyBillingEvent(event, { actor: "billing:webhook" });
  } catch (error) {
    return failure(error);
  }

  return received();
}

function received(): Response {
  return Response.json({ received: true }, { status: 200 });
}

/**
 * Everything that is not a signature refusal. A `BillingError` carries its own
 * verdict in `retryable` — a misconfiguration is ours to fix and so should be
 * re-delivered (500); a malformed payload never will be (400).
 */
function failure(error: unknown): Response {
  if (error instanceof BillingError) {
    console.error("[billing] webhook rejected", { code: error.code });
    return Response.json(
      { error: error.code },
      { status: error.retryable ? 500 : 400 },
    );
  }
  console.error("[billing] webhook failed", {
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : undefined,
  });
  return Response.json({ error: "internal_error" }, { status: 500 });
}
