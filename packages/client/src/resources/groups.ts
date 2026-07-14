import type { HttpClient } from "../internal/http.js";
import type {
  AddGroupMemberInput,
  AddGroupMemberResult,
  GetGroupInput,
  Group,
  GroupMember,
  IdentifyGroupInput,
  ListGroupMembersInput,
  ListGroupsInput,
  RemoveGroupMemberInput,
  RemoveGroupMemberResult,
} from "../types.js";

/**
 * The `groups.*` resource bound to an {@link HttpClient} — the SECRET-KEY-ONLY
 * group data plane (`/v1/groups`). Group PROPERTY writes and membership
 * mutations are operator data, so they never leave the server; the browser SDK
 * may only ASSOCIATE (attach a `groups` map to an ingested event).
 *
 * A group is addressed by its `(groupType, groupKey)` natural key; both path
 * segments are URL-encoded so keys carrying `/` or reserved chars are safe.
 */
export class GroupsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Identify (upsert) a group by its natural key. Merges `properties` onto the
   * group's property bag (new keys win) and mirrors the write to the active
   * analytics provider (PostHog `groupIdentify`). Returns the resolved group.
   */
  async identify(input: IdentifyGroupInput): Promise<Group> {
    const res = await this.http.post<{ group: Group }>("/v1/groups", {
      groupType: input.groupType,
      groupKey: input.groupKey,
      displayName: input.displayName,
      properties: input.properties,
    });
    return res.group;
  }

  /**
   * Fetch a single group by its natural key. Throws a {@link HogsendAPIError}
   * with `status === 404` when the group does not exist.
   */
  async get(input: GetGroupInput): Promise<Group> {
    const res = await this.http.get<{ group: Group }>(
      `/v1/groups/${encodeURIComponent(input.groupType)}/${encodeURIComponent(
        input.groupKey,
      )}`,
    );
    return res.group;
  }

  /** List groups, newest-seen first. Filter with `groupType`; page with `limit`/`offset`. */
  async list(input: ListGroupsInput = {}): Promise<Group[]> {
    const res = await this.http.get<{ groups: Group[] }>("/v1/groups", {
      groupType: input.groupType,
      limit: input.limit,
      offset: input.offset,
    });
    return res.groups;
  }

  /**
   * Add a contact to a group (resolve-or-create the group first). `created`
   * reflects whether THIS call inserted the membership (a re-add returns
   * `created:false`).
   */
  addMember(input: AddGroupMemberInput): Promise<AddGroupMemberResult> {
    return this.http.post<AddGroupMemberResult>(
      `/v1/groups/${encodeURIComponent(input.groupType)}/${encodeURIComponent(
        input.groupKey,
      )}/members`,
      { contactId: input.contactId, role: input.role },
    );
  }

  /**
   * Remove a contact from a group. `contactId` travels in the PATH (no body).
   * `removed` is false when the group or membership did not exist.
   */
  removeMember(
    input: RemoveGroupMemberInput,
  ): Promise<RemoveGroupMemberResult> {
    return this.http.del<RemoveGroupMemberResult>(
      `/v1/groups/${encodeURIComponent(input.groupType)}/${encodeURIComponent(
        input.groupKey,
      )}/members/${encodeURIComponent(input.contactId)}`,
    );
  }

  /** List a group's members, newest-joined first. Returns `[]` for an unknown group. */
  async listMembers(input: ListGroupMembersInput): Promise<GroupMember[]> {
    const res = await this.http.get<{ members: GroupMember[] }>(
      `/v1/groups/${encodeURIComponent(input.groupType)}/${encodeURIComponent(
        input.groupKey,
      )}/members`,
      { limit: input.limit, offset: input.offset },
    );
    return res.members;
  }
}
