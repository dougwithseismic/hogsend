/**
 * Augmentable registry of the group types your app uses. Empty by design —
 * consumers narrow it via module augmentation (a `groups.d.ts`, mirroring the
 * `templates.d.ts` pattern for the email template registry):
 *
 * ```ts
 * declare module "@hogsend/core" {
 *   interface GroupTypeMap {
 *     company: true;
 *     team: true;
 *   }
 * }
 * ```
 *
 * Once augmented, every `GroupType`-typed field (e.g. a group-scoped wait's
 * `group` option) autocompletes and rejects unknown types at compile time.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target by design
export interface GroupTypeMap {}

/**
 * A group type name (e.g. "company"). Degrades to plain `string` while
 * {@link GroupTypeMap} is unaugmented; narrows to the augmented keys once a
 * consumer declares them.
 */
export type GroupType = keyof GroupTypeMap extends never
  ? string
  : keyof GroupTypeMap & string;

/**
 * The groupType→groupKey association map carried on an event — the set of
 * groups an event belongs to (e.g. `{ company: "acme.com", team: "growth" }`).
 * Mirrors `user_events.groups`. Keys are group types, values are group keys.
 */
export type GroupsAssociation = Record<string, string>;

/**
 * The portable domain/row shape for a first-class account/team/company-level
 * entity. A group is identified by its `(groupType, groupKey)` natural key
 * (e.g. type "company" + key "acme.com"), scoped to an optional tenant.
 * SDK-facing — a plain hand-written interface, deliberately decoupled from the
 * drizzle `$inferSelect` row type so consumers don't take a DB dependency.
 */
export interface Group {
  id: string;
  /** Multi-tenant scope (nullable today, like contacts.organizationId). */
  organizationId: string | null;
  /** The group's kind, e.g. "company" / "team". Part of the natural key. */
  groupType: string;
  /** The external id within a type — a domain, an account id, etc. */
  groupKey: string;
  displayName: string | null;
  properties: Record<string, unknown> | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A contact's membership in a group (e.g. a person belonging to a "company").
 * Both sides are real uuid references — a membership exists only after both the
 * group and the contact do.
 */
export interface GroupMembership {
  id: string;
  /** Multi-tenant scope (nullable today, like contacts.organizationId). */
  organizationId: string | null;
  groupId: string;
  contactId: string;
  /** Optional role of the contact within the group (e.g. "admin", "member"). */
  role: string | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input to identify/upsert a group and its properties — the write-side shape
 * that resolves (or creates) a group by its natural key and merges properties.
 */
export interface GroupIdentifyInput {
  groupType: string;
  groupKey: string;
  displayName?: string;
  properties?: Record<string, unknown>;
  organizationId?: string;
}

/**
 * Input to associate a contact with a group — resolves the group by its natural
 * key and creates (or updates) the membership for the given contact.
 */
export interface GroupMemberInput {
  groupType: string;
  groupKey: string;
  contactId: string;
  role?: string;
}
