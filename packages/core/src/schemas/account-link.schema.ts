import { z } from "zod";
import { ACCOUNT_LINK_ID_RE } from "../providers/account-link.js";

/**
 * A provider id, on the wire. Reuses {@link ACCOUNT_LINK_ID_RE} rather than
 * restating the pattern, so the route validator and the authoring guard in
 * `defineAccountLink` can never disagree about what a legal id is.
 *
 * It deliberately does NOT reject {@link RESERVED_ACCOUNT_LINK_IDS}: reserved
 * ids are an AUTHORING constraint (they would shadow a literal route segment),
 * and a request naming one should 404 as an unknown provider rather than 422 as
 * a malformed one.
 */
export const accountLinkProviderIdSchema = z.string().regex(ACCOUNT_LINK_ID_RE);

/**
 * The platform's IMMUTABLE user id (Steam `steamid64`, Twitch numeric user id).
 * Bounded because it is half of the `(provider, provider_user_id)` natural key
 * and appears in an outbound dedupe key; no real platform id is near 255 chars.
 */
export const providerUserIdSchema = z.string().min(1).max(255);

/**
 * `linked_accounts.version`, on the wire.
 *
 * A Postgres `bigint`, so it is a numeric STRING everywhere and NEVER a JS
 * `number`: it exceeds `Number.MAX_SAFE_INTEGER`, and a rounded version breaks
 * the consumer's `incoming.version > stored.version` guard in exactly the case
 * that guard exists for. `z.coerce.number()` here would be the bug, not the
 * convenience. Compare as `BigInt(a) > BigInt(b)`.
 */
export const accountLinkVersionSchema = z.string().regex(/^\d+$/);

/** A grant, on the wire. Mirrors {@link import("../providers/account-link.js").LinkTokens}. */
export const linkTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** ISO 8601 with offset. */
  expiresAt: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

/**
 * Property values a provider may put on a link. Clamped to SCALARS because they
 * land on `contacts.properties`, which journeys and buckets read directly — a
 * nested object or an array has nowhere to go there.
 */
const linkPropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * The wire validator for a proven identity, structurally identical to
 * {@link import("../providers/account-link.js").LinkedIdentity} (a bidirectional
 * type-equality assertion in `account-link.schema.test.ts` fails to compile if
 * the two ever drift).
 *
 * `verifiedEmail` is named for what it is: a provider only fills it when the
 * platform MARKS the address verified, and even then it is a contact PROPERTY
 * that may MATCH a contact — never a merge key.
 */
export const linkedIdentitySchema = z.object({
  providerUserId: providerUserIdSchema,
  /** Mutable display handle. Never a key. */
  username: z.string().optional(),
  verifiedEmail: z.email().optional(),
  // http(s) only: this string is rendered as an `<img src>` in Studio and in
  // the hosted pages, and `z.url()` on its own happily accepts `javascript:`.
  avatarUrl: z.url({ protocol: /^https?$/ }).optional(),
  tokens: linkTokensSchema.optional(),
  properties: z.record(z.string(), linkPropertyValueSchema).optional(),
});

/** How a link came to exist. Matches `AfterLinkContext["method"]`. */
export const linkMethodSchema = z.enum(["oauth", "import"]);

/** Why a link went away. Matches `AfterUnlinkContext["reason"]`. */
export const unlinkReasonSchema = z.enum(["player", "api", "relinked"]);
