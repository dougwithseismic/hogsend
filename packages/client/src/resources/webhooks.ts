import type { HttpClient } from "../internal/http.js";
import type {
  CreatedWebhookEndpoint,
  CreateWebhookInput,
  RotateWebhookSecretResult,
  UpdateWebhookInput,
  WebhookEndpoint,
} from "../types.js";

const BASE = "/v1/admin/webhooks";

/**
 * The `webhooks.*` resource — manage outbound webhook endpoints (the
 * Svix-style signed event stream Hogsend emits to subscriber URLs).
 *
 * IMPORTANT: unlike the rest of the client (which uses an `ingest`-scoped data
 * key), this resource targets the ADMIN plane (`/v1/admin/webhooks`) and
 * REQUIRES a full-admin key. Signing-secret management is the same trust class
 * as API-key management — a leaked ingest key must never register an
 * exfiltration endpoint. Construct the client with an admin `apiKey`.
 *
 * The full signing `secret` (`whsec_…`) is returned ONCE — on
 * {@link WebhooksResource.create} and {@link WebhooksResource.rotateSecret}.
 * `list`/`get` only ever expose the display `secretPrefix`. Store it on create.
 */
export class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Register a new endpoint subscribed to one or more outbound event types.
   * For the default kind="webhook", returns the endpoint INCLUDING the full
   * signing `secret` — the only time (besides rotate) it is returned; store it
   * now. For a keyed destination (e.g. `{ kind: "posthog", config: { apiKey } }`)
   * no secret is returned (it authenticates via `config`).
   */
  create(input: CreateWebhookInput): Promise<CreatedWebhookEndpoint> {
    return this.http.post<CreatedWebhookEndpoint>(BASE, {
      url: input.url,
      eventTypes: input.eventTypes,
      description: input.description,
      disabled: input.disabled,
      kind: input.kind,
      config: input.config,
    });
  }

  /**
   * List endpoints (newest first). Disabled endpoints are hidden unless
   * `includeDisabled` is set. Returns the endpoints array (unwrapped from the
   * `{ endpoints, total, limit, offset }` envelope).
   */
  async list(opts?: {
    limit?: number;
    offset?: number;
    includeDisabled?: boolean;
  }): Promise<WebhookEndpoint[]> {
    const res = await this.http.get<{ endpoints: WebhookEndpoint[] }>(BASE, {
      limit: opts?.limit,
      offset: opts?.offset,
      includeDisabled:
        opts?.includeDisabled === undefined
          ? undefined
          : String(opts.includeDisabled),
    });
    return res.endpoints;
  }

  /** Fetch one endpoint by id (404 → {@link HogsendAPIError}). */
  get(id: string): Promise<WebhookEndpoint> {
    return this.http.get<WebhookEndpoint>(`${BASE}/${encodeURIComponent(id)}`);
  }

  /**
   * Patch an endpoint. Only the provided fields change; `description: null`
   * clears the description. Does NOT return or rotate the secret.
   */
  update(id: string, input: UpdateWebhookInput): Promise<WebhookEndpoint> {
    return this.http.patch<WebhookEndpoint>(
      `${BASE}/${encodeURIComponent(id)}`,
      {
        url: input.url,
        eventTypes: input.eventTypes,
        description: input.description,
        disabled: input.disabled,
        kind: input.kind,
        config: input.config,
      },
    );
  }

  /** Hard-delete an endpoint (cascade drops its deliveries). */
  delete(id: string): Promise<{ deleted: boolean }> {
    return this.http.del<{ deleted: boolean }>(
      `${BASE}/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Rotate the signing secret. The OLD secret is invalidated immediately (hard
   * cutover) — update every subscriber with the returned new `secret` (returned
   * ONCE).
   */
  rotateSecret(id: string): Promise<RotateWebhookSecretResult> {
    return this.http.post<RotateWebhookSecretResult>(
      `${BASE}/${encodeURIComponent(id)}/rotate-secret`,
      {},
    );
  }

  /**
   * Enqueue an out-of-band `webhook.test` delivery to the endpoint, delivered
   * regardless of its subscribed `eventTypes`. Returns the 202 enqueue ack.
   */
  sendTest(
    id: string,
  ): Promise<{ enqueued: boolean; eventType: "webhook.test" }> {
    return this.http.post<{ enqueued: boolean; eventType: "webhook.test" }>(
      `${BASE}/${encodeURIComponent(id)}/test`,
      {},
    );
  }
}
