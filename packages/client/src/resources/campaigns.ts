import type { HttpClient } from "../internal/http.js";
import type {
  Campaign,
  ListCampaignsInput,
  ListCampaignsResult,
  SendCampaignInput,
  SendCampaignResult,
} from "../types.js";

/** The `campaigns.*` resource bound to an {@link HttpClient}. */
export class CampaignsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Queue a broadcast: durably send one template to every subscribed member of
   * a `list` (or every active member of a `bucket`). Exactly one of `list` /
   * `bucket` must be set; `template`/`props` are type-checked against the
   * augmented `TemplateRegistryMap` when `@hogsend/email` is installed, else
   * degrade to `{ template: string; props? }`. Pass `sendAt` to schedule the
   * blast for a future instant instead of sending immediately.
   *
   * Returns the 202 ack (`{ campaignId, status, scheduledAt }`); the actual
   * sends run asynchronously in the worker. Poll {@link CampaignsResource.get}
   * for counts.
   */
  send(input: SendCampaignInput): Promise<SendCampaignResult> {
    // The discriminated union narrows `template`/`props` and the audience; index
    // into the input via a permissive view to build the wire body without
    // re-discriminating.
    const body = input as SendCampaignInput & {
      list?: string;
      bucket?: string;
      props?: Record<string, unknown>;
    };
    return this.http.post<SendCampaignResult>("/v1/campaigns", {
      name: body.name,
      list: body.list,
      bucket: body.bucket,
      template: body.template,
      props: body.props,
      from: body.from,
      subject: body.subject,
      sendAt:
        body.sendAt instanceof Date ? body.sendAt.toISOString() : body.sendAt,
      idempotencyKey: body.idempotencyKey,
    });
  }

  /** Fetch a campaign's current status + send counts. */
  get(id: string): Promise<Campaign> {
    return this.http.get<Campaign>(`/v1/campaigns/${encodeURIComponent(id)}`);
  }

  /** List campaigns, newest first. Filter with `status`; page with `limit`/`offset`. */
  list(input: ListCampaignsInput = {}): Promise<ListCampaignsResult> {
    return this.http.get<ListCampaignsResult>("/v1/campaigns", {
      status: input.status?.join(","),
      limit: input.limit !== undefined ? String(input.limit) : undefined,
      offset: input.offset !== undefined ? String(input.offset) : undefined,
    });
  }

  /**
   * Cancel a `scheduled`, `queued`, or `sending` campaign. A mid-send cancel
   * stops the blast at the next chunk boundary — recipients not yet dispatched
   * are spared; already-dispatched sends are not recalled. Terminal campaigns
   * reject with a 409 `HogsendApiError`.
   */
  cancel(id: string): Promise<Campaign> {
    return this.http.post<Campaign>(
      `/v1/campaigns/${encodeURIComponent(id)}/cancel`,
      {},
    );
  }
}
