import type { HttpClient } from "../internal/http.js";
import { assertIdentity } from "../internal/identity.js";
import type {
  Contact,
  DeleteContactInput,
  DeleteContactResult,
  FindContactsInput,
  UpsertContactInput,
  UpsertContactResult,
} from "../types.js";

/** The `contacts.*` resource bound to an {@link HttpClient}. */
export class ContactsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Upsert a contact by identity. Resolves/merges server-side and optionally
   * applies list membership. Returns `{ id, created, linked }`.
   */
  async upsert(input: UpsertContactInput): Promise<UpsertContactResult> {
    assertIdentity(input);
    return this.http.put<UpsertContactResult>("/v1/contacts", {
      email: input.email,
      userId: input.userId,
      anonymousId: input.anonymousId,
      properties: input.properties,
      lists: input.lists,
    });
  }

  /** Find non-deleted contacts by `email` or `userId`. */
  async find(input: FindContactsInput): Promise<Contact[]> {
    const query: Record<string, string | undefined> = {
      email: "email" in input ? input.email : undefined,
      userId: "userId" in input ? input.userId : undefined,
    };
    const res = await this.http.get<{ contacts: Contact[] }>(
      "/v1/contacts/find",
      query,
    );
    return res.contacts;
  }

  /** Soft-delete a contact by identity. */
  async delete(input: DeleteContactInput): Promise<DeleteContactResult> {
    assertIdentity(input);
    return this.http.del<DeleteContactResult>("/v1/contacts", {
      email: input.email,
      userId: input.userId,
    });
  }
}
