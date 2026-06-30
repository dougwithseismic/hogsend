import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { purchase } from "@/lib/db/schema";
import { getStripe, paywallConfigured } from "@/lib/stripe";

/**
 * Billing reads for the account page. Purchases are the DB source of truth
 * (always available); Stripe invoices add downloadable PDFs/receipts where a
 * purchase generated one (invoice_creation on checkout — see /api/checkout).
 * Everything degrades gracefully when Stripe is unconfigured.
 */

export type PurchaseRow = {
  courseSlug: string;
  status: string;
  amount: number | null;
  currency: string | null;
  createdAt: Date;
};

export type InvoiceRow = {
  number: string | null;
  amount: number;
  currency: string;
  created: number;
  status: string | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
};

/** A user's purchases, newest first (the durable record of what they own). */
export async function listPurchases(userId: string): Promise<PurchaseRow[]> {
  return db
    .select({
      courseSlug: purchase.courseSlug,
      status: purchase.status,
      amount: purchase.amount,
      currency: purchase.currency,
      createdAt: purchase.createdAt,
    })
    .from(purchase)
    .where(eq(purchase.userId, userId))
    .orderBy(desc(purchase.createdAt));
}

/** The user's Stripe customer id, if any purchase recorded one. */
async function getCustomerId(userId: string): Promise<string | null> {
  const rows = await db
    .select({ customerId: purchase.stripeCustomerId })
    .from(purchase)
    .where(eq(purchase.userId, userId))
    .orderBy(desc(purchase.createdAt));
  const withId = rows.find((r) => r.customerId);
  return withId?.customerId ?? null;
}

/** Downloadable Stripe invoices for the user (empty when unconfigured / none). */
export async function listInvoices(userId: string): Promise<InvoiceRow[]> {
  if (!paywallConfigured()) return [];
  const customerId = await getCustomerId(userId);
  if (!customerId) return [];
  try {
    const res = await getStripe().invoices.list({
      customer: customerId,
      limit: 100,
    });
    return res.data.map((inv) => ({
      number: inv.number ?? null,
      amount: inv.amount_paid,
      currency: inv.currency,
      created: inv.created,
      status: inv.status ?? null,
      hostedUrl: inv.hosted_invoice_url ?? null,
      pdfUrl: inv.invoice_pdf ?? null,
    }));
  } catch {
    return [];
  }
}
