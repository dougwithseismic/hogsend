import type { HttpClient } from "../internal/http.js";
import type {
  Campaign,
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
   * degrade to `{ template: string; props? }`.
   *
   * Returns the 202 enqueue ack (`{ campaignId, status }`); the actual sends run
   * asynchronously in the worker. Poll {@link CampaignsResource.get} for counts.
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
    });
  }

  /** Fetch a campaign's current status + send counts. */
  get(id: string): Promise<Campaign> {
    return this.http.get<Campaign>(`/v1/campaigns/${encodeURIComponent(id)}`);
  }
}
