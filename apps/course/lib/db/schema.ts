import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Course-site database schema. The first four tables are Better Auth's required
 * core models (singular names + camelCase fields so the Drizzle adapter resolves
 * with no remapping). `enrollment` and `lesson_progress` are app tables. This is
 * the course's OWN database — NOT the engine/dogfood DB.
 */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** A reader's enrollment in a course (one row per user × course). */
export const enrollment = pgTable(
  "enrollment",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    courseSlug: text("course_slug").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("enrollment_user_course_uq").on(t.userId, t.courseSlug)],
);

/** One row per completed lesson (idempotent via the unique index). */
export const lessonProgress = pgTable(
  "lesson_progress",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    courseSlug: text("course_slug").notNull(),
    lessonSlug: text("lesson_slug").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("lesson_progress_user_course_lesson_uq").on(
      t.userId,
      t.courseSlug,
      t.lessonSlug,
    ),
    index("lesson_progress_user_course_idx").on(t.userId, t.courseSlug),
  ],
);

/**
 * A reader's saved answer to an interactive lesson block — a quiz result, a
 * profile check-in, or a plan checklist. One row per user × block key; the
 * latest answer wins (upsert on the unique index). `key` is namespaced by the
 * block kind (e.g. "profile:role", "quiz:growth-with-posthog/02-aarrr…"), and
 * `value` is the block-shaped JSON payload. courseSlug/lessonSlug record where
 * the answer was given, for context — the key alone identifies the block.
 */
export const response = pgTable(
  "response",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    kind: text("kind").notNull(), // profile | quiz | checklist
    value: jsonb("value").notNull(),
    courseSlug: text("course_slug"),
    lessonSlug: text("lesson_slug"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("response_user_key_uq").on(t.userId, t.key),
    index("response_user_idx").on(t.userId),
  ],
);

/**
 * A gifted copy of a course: the buyer pays full price and we mint a
 * single-use 100%-off Stripe promotion code instead of granting the buyer an
 * entitlement. The recipient redeems the code through normal checkout (a $0
 * session → the purchase webhook grants THEIR entitlement). The row is claimed
 * idempotently on the buyer's checkout-session id BEFORE the code is minted,
 * so a retried webhook delivery can resume a half-finished mint without ever
 * creating a second code; empty code fields mark that pending state.
 */
export const gift = pgTable(
  "gift",
  {
    id: text("id").primaryKey(),
    buyerUserId: text("buyer_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    courseSlug: text("course_slug").notNull(),
    /** Where to send the gift email; null = buyer forwards the code himself. */
    recipientEmail: text("recipient_email"),
    /** The human code (GIFT-XXXXXX); "" while the mint is pending. */
    promotionCode: text("promotion_code").notNull().default(""),
    stripePromotionCodeId: text("stripe_promotion_code_id")
      .notNull()
      .default(""),
    stripeCouponId: text("stripe_coupon_id").notNull().default(""),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
    amount: integer("amount"),
    currency: text("currency"),
    redeemedByUserId: text("redeemed_by_user_id"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gift_checkout_session_uq").on(t.stripeCheckoutSessionId),
    index("gift_buyer_idx").on(t.buyerUserId),
  ],
);

/**
 * A team licence pack: one checkout buys `seats` copies of a course, and the
 * webhook mints `seats` single-use 100%-off codes (one licenseCode row each)
 * which are emailed to the buyer to distribute. The pack row is claimed
 * idempotently on the checkout-session id BEFORE any code is minted, so a
 * retried webhook delivery resumes a half-finished mint (only the missing
 * remainder is minted), and `emailedAt` gates the codes email so a resumed
 * retry still sends it exactly once.
 */
export const licensePack = pgTable(
  "license_pack",
  {
    id: text("id").primaryKey(),
    buyerUserId: text("buyer_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    courseSlug: text("course_slug").notNull(),
    seats: integer("seats").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
    amount: integer("amount"),
    currency: text("currency"),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("license_pack_checkout_session_uq").on(
      t.stripeCheckoutSessionId,
    ),
    index("license_pack_buyer_idx").on(t.buyerUserId),
  ],
);

/**
 * One minted seat code in a licence pack. Rows are inserted only AFTER the
 * Stripe mint succeeds, so every row carries a real redeemable code (a crash
 * between mint and insert leaks an orphan Stripe coupon that is never sent to
 * anyone — the resumed mint replaces it).
 */
export const licenseCode = pgTable(
  "license_code",
  {
    id: text("id").primaryKey(),
    packId: text("pack_id")
      .notNull()
      .references(() => licensePack.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    stripePromotionCodeId: text("stripe_promotion_code_id").notNull(),
    stripeCouponId: text("stripe_coupon_id").notNull(),
    redeemedByUserId: text("redeemed_by_user_id"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("license_code_code_uq").on(t.code),
    index("license_code_pack_idx").on(t.packId),
  ],
);

/**
 * A one-time course purchase (entitlement). One active grant per user × course.
 * Written by the Stripe webhook (checkout.session.completed), read by the gate
 * (hasAccess). `status` flips to "refunded" on charge.refunded → access is
 * revoked. The two unique indexes give: O(1) entitlement lookup, and webhook
 * idempotency (a retried delivery for the same checkout session is a no-op).
 */
export const purchase = pgTable(
  "purchase",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    courseSlug: text("course_slug").notNull(),
    status: text("status").notNull().default("paid"), // paid | refunded
    stripeCustomerId: text("stripe_customer_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    amount: integer("amount"), // minor units, for records
    currency: text("currency"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("purchase_user_course_uq").on(t.userId, t.courseSlug),
    uniqueIndex("purchase_checkout_session_uq").on(t.stripeCheckoutSessionId),
  ],
);
