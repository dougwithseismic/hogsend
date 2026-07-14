import { z } from "zod";

/** A group's kind, e.g. "company" / "team". Non-empty. */
export const groupTypeSchema = z.string().min(1);

/** The external id within a type — a domain, an account id, etc. Non-empty. */
export const groupKeySchema = z.string().min(1);

/**
 * The groupType→groupKey association map carried on an event (mirrors
 * `user_events.groups`). Zod v4 `z.record` takes BOTH a key schema and a value
 * schema — both are non-empty strings here.
 */
export const groupsAssociationSchema = z.record(
  z.string().min(1),
  z.string().min(1),
);

/**
 * Identify/upsert a group and its properties by natural key. Structurally
 * compatible with {@link import("../types/group.js").GroupIdentifyInput}.
 */
export const groupIdentifySchema = z.object({
  groupType: groupTypeSchema,
  groupKey: groupKeySchema,
  displayName: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Associate a contact with a group by natural key. Structurally compatible with
 * {@link import("../types/group.js").GroupMemberInput}.
 */
export const groupMemberSchema = z.object({
  groupType: groupTypeSchema,
  groupKey: groupKeySchema,
  contactId: z.string().min(1),
  role: z.string().optional(),
});
