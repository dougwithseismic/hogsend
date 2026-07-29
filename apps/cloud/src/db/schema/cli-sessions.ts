import {
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { user } from "./auth";
import { organizations } from "./organizations";

/**
 * The credential `hogsend login` leaves behind — one row per machine a human
 * approved from the dashboard.
 *
 * Same posture as `publish_tokens`, for the same reason: the secret is only
 * ever CHECKED, so only its sha256 is stored and nothing here can read a token
 * back. What is DIFFERENT is what the credential means. A publish token belongs
 * to an ENVIRONMENT; a CLI session belongs to a PERSON acting inside an
 * ORGANIZATION, so authorization is resolved live at every use — the row names
 * the user and the org, and the intake re-reads the membership. A session
 * therefore stops being able to publish the moment the human loses the role,
 * with no rotation and no sweep.
 *
 * `revoked_at` rather than a delete: "which machines could reach this org, and
 * when did that stop" is a question an operator asks after an incident, and a
 * deleted row cannot answer it.
 */
export const cliSessions = cloud.table(
  "cli_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** sha256 hex of the whole `hscli_…` token. Never the token. */
    tokenHash: text("token_hash").notNull(),
    /** Display-only tail of the secret, so a human can match machine to row. */
    last4: text("last4").notNull(),
    /** Who approved it. Authorization is re-derived from this, never stored. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The organization the approval bound it to — the tenancy boundary. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** What the CLI called itself, e.g. a hostname. Untrusted, display-only. */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Last accepted use. Written THROTTLED (see `CLI_SESSION_TOUCH_STALE_MS`):
     * a build-status poll runs every few seconds, and a write per poll would
     * turn a read endpoint into a write amplifier for no extra truth.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Set by a dashboard revoke. A revoked session fails closed on next use. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // Verification's access path, and the guarantee that no two sessions can
    // share a hash.
    uniqueIndex("cli_sessions_token_hash_unique_idx").on(table.tokenHash),
    // The Settings list: one org's sessions, newest first.
    index("cli_sessions_organization_id_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("cli_sessions_user_id_idx").on(table.userId),
  ],
);

/**
 * One in-flight `hogsend login`: the pair of codes the OAuth device flow is
 * built from, and the approval a dashboard user later attaches to them.
 *
 * The split is the whole security model:
 *  - the DEVICE CODE is a high-entropy secret only the CLI holds, stored
 *    hashed, and is the ONLY thing that can exchange an approval for a token;
 *  - the USER CODE is short enough to read down a phone line, so it is
 *    deliberately powerless — quoting one approves nothing. It only NAMES a
 *    pending request to a dashboard user who is already signed in, and the
 *    approval writes the user + org onto the row.
 *
 * The token is minted at EXCHANGE, not at approval, so the plaintext exists in
 * exactly one poll response and never at rest: `consumed_at` is the single-use
 * latch, set by a guarded update, and a second poll gets nothing.
 */
export const cliDeviceCodes = cloud.table(
  "cli_device_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** sha256 hex of the `hscd_…` poll secret. Never the device code. */
    deviceCodeHash: text("device_code_hash").notNull(),
    /** The short human code, `XXXX-XXXX` from an unambiguous alphabet. */
    userCode: text("user_code").notNull(),
    /** What the CLI called itself. Shown on the approve page, untrusted. */
    label: text("label"),
    status: text("status")
      .$type<"pending" | "approved" | "denied" | "expired">()
      .default("pending")
      .notNull(),
    /** Set by approval — the org the minted session will be bound to. */
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    /** Set by approval — the dashboard user who clicked Approve. */
    approvedByUserId: text("approved_by_user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    /**
     * The session this code was exchanged for. Written at EXCHANGE, so it is
     * the trail from "a code was approved" to "this machine got a credential".
     */
    approvedSessionId: uuid("approved_session_id").references(
      () => cliSessions.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** The single-use latch: set by the poll that returned the token. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // The poll's access path.
    uniqueIndex("cli_device_codes_device_code_hash_unique_idx").on(
      table.deviceCodeHash,
    ),
    // Two live requests must never share a user code, or an approval would be
    // ambiguous about which machine it just authorised.
    uniqueIndex("cli_device_codes_user_code_unique_idx").on(table.userCode),
    // The reaper's scan.
    index("cli_device_codes_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Fixed-window request counters, keyed by an opaque bucket string.
 *
 * A TABLE rather than an in-memory LRU, deliberately: the device endpoints are
 * unauthenticated and the control plane runs more than one Next.js instance, so
 * a per-process counter would multiply every limit by the replica count — the
 * one failure mode a brute-force limit may not have. The increment is a single
 * upsert (`count = count + 1 RETURNING count`), so two replicas racing the same
 * window serialise on the row rather than both reading a stale count.
 *
 * Rows are garbage, not records: `window_start` is indexed so old windows can
 * be swept, and nothing reads a window once it has passed.
 */
export const cliRateLimits = cloud.table(
  "cli_rate_limits",
  {
    /** `<scope>:<identity>`, e.g. `cli_device_mint:203.0.113.9`. */
    bucket: text("bucket").notNull(),
    /** Truncated window start; the second half of the identity. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "cli_rate_limits_pkey",
      columns: [table.bucket, table.windowStart],
    }),
    index("cli_rate_limits_window_start_idx").on(table.windowStart),
  ],
);
