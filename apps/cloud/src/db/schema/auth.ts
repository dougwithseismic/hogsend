import { boolean, index, text, timestamp } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";

/**
 * Better Auth's own tables for the control plane (`src/lib/auth.ts`), in the
 * `cloud` Postgres schema alongside everything else so one database can never
 * mix the control plane with an engine instance's `public` tables.
 *
 * Shape is Better Auth's — generated from `getAuthTables()` for the exact
 * plugin set we run (email-otp + organization) and matched to the engine's
 * `packages/db/src/schema/auth.ts` so the two stay recognisably the same. The
 * `updatedAt` columns Better Auth does not itself write carry a DB default, so
 * an insert that omits them still succeeds.
 *
 * NOTE the naming split: `organization` here is Better Auth's table; the
 * control plane's tenant record is `cloud.organizations` (plural,
 * `./organizations`) and is keyed BY this table's id.
 */

export const user = cloud.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  ...timestamps,
});

export const session = cloud.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Set by the organization plugin when a member switches org. */
    activeOrganizationId: text("active_organization_id"),
    ...timestamps,
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = cloud.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    /** Argon2id hash for the `credential` provider. Never read by the app. */
    password: text("password"),
    ...timestamps,
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

/** OTP codes and reset tokens; rows are consumed and deleted. */
export const verification = cloud.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = cloud.table("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  ...timestamps,
});

export const member = cloud.table(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    ...timestamps,
  },
  (table) => [index("member_organization_id_idx").on(table.organizationId)],
);

export const invitation = cloud.table(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [index("invitation_email_idx").on(table.email)],
);
