import { createHttpClient } from "./internal/http.js";
import { CampaignsResource } from "./resources/campaigns.js";
import { ContactsResource } from "./resources/contacts.js";
import { EmailsResource } from "./resources/emails.js";
import { EventsResource } from "./resources/events.js";
import { ListsResource } from "./resources/lists.js";
import { WebhooksResource } from "./resources/webhooks.js";
import type { HogsendOptions } from "./types.js";

/**
 * Typed HTTP client for the Hogsend data plane.
 *
 * ```ts
 * const hs = new Hogsend({ baseUrl: "https://api.example.com", apiKey: "hsk_…" });
 * await hs.contacts.upsert({ email: "a@b.com", properties: { plan: "pro" } });
 * await hs.events.send({ userId: "u_1", name: "signup" });
 * ```
 */
export class Hogsend {
  readonly contacts: ContactsResource;
  readonly events: EventsResource;
  readonly emails: EmailsResource;
  readonly lists: ListsResource;
  readonly campaigns: CampaignsResource;
  /**
   * Manage outbound webhook endpoints (the signed event stream Hogsend emits to
   * subscriber URLs). REQUIRES a full-admin `apiKey` — this resource hits the
   * admin plane (`/v1/admin/webhooks`), NOT the ingest data plane the other
   * resources use. See {@link WebhooksResource}.
   */
  readonly webhooks: WebhooksResource;

  constructor(opts: HogsendOptions) {
    if (!opts.baseUrl) {
      throw new TypeError("Hogsend: `baseUrl` is required.");
    }
    if (!opts.apiKey) {
      throw new TypeError("Hogsend: `apiKey` is required.");
    }

    const http = createHttpClient({
      baseUrl: opts.baseUrl.replace(/\/+$/, ""),
      apiKey: opts.apiKey,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
      headers: opts.headers,
    });

    this.contacts = new ContactsResource(http);
    this.events = new EventsResource(http);
    this.emails = new EmailsResource(http);
    this.lists = new ListsResource(http);
    this.campaigns = new CampaignsResource(http);
    this.webhooks = new WebhooksResource(http);
  }
}
