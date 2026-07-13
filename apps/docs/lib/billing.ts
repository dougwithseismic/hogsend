import { postToHogsendApi } from "@/lib/hogsend-api";

/**
 * Server-side read of the customer's billing state (card on file + invoice
 * history) from the Hono API's `POST /me/billing` — same wire + fail-soft
 * contract as lib/services. Null means "couldn't load"; the portal renders a
 * soft retry state. Entries are sanitized per-element (the API deploys
 * independently, so a shape drift must degrade, not crash).
 */

export type BillingInvoice = {
  number: string;
  /** Amount paid in the currency's minor unit. */
  amount: number;
  currency: string;
  /** ISO timestamp. */
  created: string;
  status: string | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
};

export type BillingSummary = {
  paymentMethod: { brand: string; last4: string } | null;
  invoices: BillingInvoice[];
};

function sanitizeInvoice(entry: unknown): BillingInvoice | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.number !== "string" || typeof e.created !== "string") {
    return null;
  }
  if (Number.isNaN(Date.parse(e.created))) return null;
  return {
    number: e.number,
    amount: typeof e.amount === "number" ? e.amount : 0,
    currency: typeof e.currency === "string" ? e.currency : "usd",
    created: e.created,
    status: typeof e.status === "string" ? e.status : null,
    hostedUrl: typeof e.hostedUrl === "string" ? e.hostedUrl : null,
    pdfUrl: typeof e.pdfUrl === "string" ? e.pdfUrl : null,
  };
}

export async function fetchBilling(input: {
  email: string;
  userId?: string;
}): Promise<BillingSummary | null> {
  const data = await postToHogsendApi<{
    paymentMethod?: unknown;
    invoices?: unknown;
  }>("/me/billing", input);
  if (!data) return null;

  const pm = data.paymentMethod as Record<string, unknown> | null | undefined;
  const paymentMethod =
    pm && typeof pm.brand === "string" && typeof pm.last4 === "string"
      ? { brand: pm.brand, last4: pm.last4 }
      : null;
  const invoices = Array.isArray(data.invoices)
    ? data.invoices
        .map(sanitizeInvoice)
        .filter((i): i is BillingInvoice => i !== null)
    : [];
  return { paymentMethod, invoices };
}
