import {
  boolean,
  index,
  integer,
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
 * A one-time course purchase (entitlement). One active grant per user × course.
 * Written by the Stripe webhook (checkout.session.completed), read by the gate
 * (hasPurchased). `status` flips to "refunded" on charge.refunded → access is
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
