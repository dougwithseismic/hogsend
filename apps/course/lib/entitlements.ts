import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ALL_ACCESS_SLUG, priceIdForCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { purchase } from "@/lib/db/schema";
import { paywallConfigured } from "@/lib/stripe";

/**
 * Entitlement layer for the one-time course paywall. The gate
 * (app/learn/[[...slug]]/page.tsx) reads `isCoursePaywalled` + `hasPurchased`;
 * the Stripe webhook writes via `recordPurchase` / `revokePurchase`. Access is
 * always DERIVED from the DB row keyed by the SESSION user id — never from a
 * query param.
 */

/** A course is paywalled iff Stripe is configured AND the course has a price id.
 *  Unconfigured → false → the gate falls back to free-with-sign-up. */
export function isCoursePaywalled(courseSlug: string): boolean {
  return paywallConfigured() && Boolean(priceIdForCourse(courseSlug));
}

/** Is the all-access bundle actually for sale (Stripe on + a price mapped)? */
export function allAccessConfigured(): boolean {
  return paywallConfigured() && Boolean(priceIdForCourse(ALL_ACCESS_SLUG));
}

/** Does this user hold a paid (non-refunded) entitlement for the course? */
export async function hasPurchased(
  userId: string,
  courseSlug: string,
): Promise<boolean> {
  const rows = await db
    .select({ status: purchase.status })
    .from(purchase)
    .where(
      and(eq(purchase.userId, userId), eq(purchase.courseSlug, courseSlug)),
    )
    .limit(1);
  return rows.length > 0 && rows[0].status === "paid";
}

/**
 * Does this user have access to a course — either by owning it directly OR by
 * holding the all-access bundle? Single round-trip (status filter + `inArray`
 * + limit(1)), so the gate stays one query. This is what the lesson gate uses;
 * `hasPurchased` stays for exact per-SKU ownership checks (e.g. upsell copy).
 */
export async function hasAccess(
  userId: string,
  courseSlug: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: purchase.id })
    .from(purchase)
    .where(
      and(
        eq(purchase.userId, userId),
        eq(purchase.status, "paid"),
        inArray(purchase.courseSlug, [courseSlug, ALL_ACCESS_SLUG]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Every paid SKU slug a user holds (courses + maybe "all-access"), as a Set, in
 * one query — so the catalog can resolve owned/locked across all cards with no
 * N+1.
 */
export async function listOwnedSlugs(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ courseSlug: purchase.courseSlug })
    .from(purchase)
    .where(and(eq(purchase.userId, userId), eq(purchase.status, "paid")));
  return new Set(rows.map((r) => r.courseSlug));
}

type RecordPurchaseArgs = {
  userId: string;
  courseSlug: string;
  stripeCustomerId?: string | null;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId?: string | null;
  amount?: number | null;
  currency?: string | null;
};

/**
 * Idempotently record a purchase. Returns true ONLY when a genuinely new row is
 * inserted, so the caller emits `course.purchased` exactly once even if Stripe
 * retries the webhook. ON CONFLICT DO NOTHING covers both unique indexes — a
 * retried checkout session OR a second session for an already-owned course is a
 * no-op.
 */
export async function recordPurchase(
  args: RecordPurchaseArgs,
): Promise<boolean> {
  const inserted = await db
    .insert(purchase)
    .values({
      id: randomUUID(),
      userId: args.userId,
      courseSlug: args.courseSlug,
      status: "paid",
      stripeCustomerId: args.stripeCustomerId ?? null,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId ?? null,
      amount: args.amount ?? null,
      currency: args.currency ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: purchase.id });
  return inserted.length > 0;
}

/** Revoke access on refund. Matches the payment intent from charge.refunded. */
export async function revokePurchase(
  stripePaymentIntentId: string,
): Promise<void> {
  await db
    .update(purchase)
    .set({ status: "refunded" })
    .where(eq(purchase.stripePaymentIntentId, stripePaymentIntentId));
}
