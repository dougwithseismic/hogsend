import type { HttpClient } from "../internal/http.js";
import { assertIdentity } from "../internal/identity.js";
import type {
  ListSummary,
  SubscribeInput,
  SubscribeResult,
  UnsubscribeResult,
} from "../types.js";

/** The `lists.*` resource bound to an {@link HttpClient}. */
export class ListsResource {
  constructor(private readonly http: HttpClient) {}

  /** List all code-defined lists. */
  async list(): Promise<ListSummary[]> {
    const res = await this.http.get<{ lists: ListSummary[] }>("/v1/lists");
    return res.lists;
  }

  /** Subscribe an identity to a list. */
  async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
    assertIdentity(input);
    const res = await this.http.post<{ list: string; subscribed: boolean }>(
      `/v1/lists/${encodeURIComponent(input.list)}/subscribe`,
      { email: input.email, userId: input.userId },
    );
    return { subscribed: res.subscribed };
  }

  /** Unsubscribe an identity from a list. */
  async unsubscribe(input: SubscribeInput): Promise<UnsubscribeResult> {
    assertIdentity(input);
    const res = await this.http.post<{ list: string; subscribed: boolean }>(
      `/v1/lists/${encodeURIComponent(input.list)}/unsubscribe`,
      { email: input.email, userId: input.userId },
    );
    return { unsubscribed: res.subscribed === false };
  }
}
