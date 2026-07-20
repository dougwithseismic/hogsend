import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type CrmLeadInput,
  type CrmMoney,
  type CrmProvider,
  type CrmPushResult,
  type CrmStageEvent,
  defineCrmProvider,
} from "@hogsend/core";

/**
 * HubSpot `CrmProvider`.
 *
 * The webhook-then-hydrate class: `deal.propertyChange` payloads carry only
 * `objectId` + `propertyName` + `propertyValue`, so stage changes hydrate the
 * deal (amount, pipeline, associated contact email) through the v3 API.
 *
 * Webhook authenticity: developer-app webhooks are verified with the v3
 * signature (HMAC-SHA256, base64, over `method + uri + body + timestamp`,
 * keyed by the app's client secret; ±5-minute timestamp window). Deployments
 * without a developer app (private-app token only) can instead configure a
 * shared secret checked against `?secret=` / `x-hubspot-secret`. One of the
 * two MUST be configured — verification fails closed.
 *
 * NOTE (verify-before-rely): shapes follow HubSpot's published v3 docs; a
 * live sandbox pass is the seam ask before production use.
 */

export interface HubspotProviderConfig {
  /** Private-app token (or OAuth access token) for API calls. */
  accessToken: string;
  /** Developer-app client secret for v3 webhook signatures. */
  clientSecret?: string;
  /** Shared-secret fallback for signature-less (workflow) webhooks. */
  webhookSecret?: string;
  /** Deal properties fetched on hydrate. */
  dealProperties?: string[];
  /** Override the API origin (tests). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Clock override (tests) for the v3 timestamp window. */
  now?: () => number;
}

interface HubspotWebhookEvent {
  objectId?: number | string;
  subscriptionType?: string;
  propertyName?: string;
  propertyValue?: string;
  occurredAt?: number;
  [key: string]: unknown;
}

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export function createHubspotProvider(
  config: HubspotProviderConfig,
): CrmProvider {
  const base = (config.baseUrl ?? "https://api.hubapi.com").replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const dealProperties = config.dealProperties ?? [
    "dealstage",
    "pipeline",
    "amount",
    "deal_currency_code",
    "hs_is_closed_won",
  ];

  async function api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `HubSpot ${method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  async function hydrateDeal(dealId: string): Promise<{
    stageId: string;
    pipelineId?: string;
    status?: "open" | "won" | "lost";
    value?: CrmMoney;
    email?: string;
    contactId?: string;
  }> {
    const deal = await api<{
      properties?: Record<string, string | null>;
      associations?: {
        contacts?: { results?: Array<{ id?: string }> };
      };
    }>(
      "GET",
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${dealProperties.join(",")}&associations=contacts`,
    );
    const props = deal.properties ?? {};
    const amountRaw = props.amount;
    const amount = amountRaw ? Number(amountRaw) : Number.NaN;
    const isWon = props.hs_is_closed_won === "true";
    const stageId = props.dealstage ?? "";
    const status: "open" | "won" | "lost" | undefined = isWon
      ? "won"
      : stageId === "closedlost"
        ? "lost"
        : undefined;

    const contactId = deal.associations?.contacts?.results?.[0]?.id;
    let email: string | undefined;
    if (contactId) {
      try {
        const contact = await api<{
          properties?: Record<string, string | null>;
        }>(
          "GET",
          `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=email`,
        );
        email = contact.properties?.email ?? undefined;
      } catch {
        // Best-effort: crm_links resolve repeat events.
      }
    }

    return {
      stageId,
      ...(props.pipeline ? { pipelineId: props.pipeline } : {}),
      ...(status ? { status } : {}),
      ...(Number.isFinite(amount)
        ? {
            value: {
              amount,
              ...(props.deal_currency_code
                ? { currency: props.deal_currency_code }
                : {}),
            },
          }
        : {}),
      ...(email ? { email } : {}),
      ...(contactId ? { contactId } : {}),
    };
  }

  function verifyAuthenticity(opts: {
    payload: string;
    headers: Record<string, string>;
    url: string;
  }): void {
    const { payload, headers, url } = opts;
    if (config.clientSecret) {
      const signature = headers["x-hubspot-signature-v3"];
      const timestamp = headers["x-hubspot-request-timestamp"];
      if (!signature || !timestamp) {
        throw new Error("HubSpot v3 signature headers missing");
      }
      if (Math.abs(now() - Number(timestamp)) > SIGNATURE_WINDOW_MS) {
        throw new Error("HubSpot webhook timestamp outside window");
      }
      const expected = createHmac("sha256", config.clientSecret)
        .update(`POST${url}${payload}${timestamp}`)
        .digest("base64");
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error("HubSpot webhook signature mismatch");
      }
      return;
    }
    if (config.webhookSecret) {
      let fromQuery: string | null = null;
      try {
        fromQuery = new URL(url).searchParams.get("secret");
      } catch {
        // header-only
      }
      const presented = headers["x-hubspot-secret"] ?? fromQuery;
      const a = Buffer.from(presented ?? "");
      const b = Buffer.from(config.webhookSecret);
      if (!presented || a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error("HubSpot webhook secret mismatch");
      }
      return;
    }
    throw new Error(
      "HubSpot webhook verification unconfigured (set clientSecret or webhookSecret)",
    );
  }

  async function eventsFromWebhook(payload: string): Promise<CrmStageEvent[]> {
    const parsed = JSON.parse(payload) as
      | HubspotWebhookEvent
      | HubspotWebhookEvent[];
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const out: CrmStageEvent[] = [];
    // One hydrate per unique deal per batch — a stage change often arrives
    // with sibling propertyChange events for the same deal.
    const seen = new Set<string>();
    for (const evt of items) {
      const type = evt.subscriptionType ?? "";
      if (!type.startsWith("deal.")) continue;
      if (type === "deal.propertyChange" && evt.propertyName !== "dealstage") {
        continue;
      }
      const dealId = evt.objectId?.toString();
      if (!dealId || seen.has(dealId)) continue;
      seen.add(dealId);
      const hydrated = await hydrateDeal(dealId);
      if (!hydrated.stageId) continue;
      out.push({
        dealId,
        ...(hydrated.contactId ? { contactId: hydrated.contactId } : {}),
        ...(hydrated.email ? { email: hydrated.email } : {}),
        ...(hydrated.pipelineId ? { pipelineId: hydrated.pipelineId } : {}),
        stageId: hydrated.stageId,
        ...(hydrated.status ? { status: hydrated.status } : {}),
        ...(hydrated.value ? { value: hydrated.value } : {}),
        occurredAt: evt.occurredAt
          ? new Date(evt.occurredAt).toISOString()
          : new Date().toISOString(),
        raw: evt,
      });
    }
    return out;
  }

  return defineCrmProvider({
    meta: {
      id: "hubspot",
      name: "HubSpot",
      description:
        "HubSpot deals sync — deal.propertyChange webhooks hydrated through the v3 API.",
    },
    capabilities: {
      auth: "apiKey",
      nativeStageWebhook: true,
      valueInWebhookPayload: false,
      atomicUpsert: false,
    },

    async pushLead(
      input: CrmLeadInput,
      _opts: { idempotencyKey: string },
    ): Promise<CrmPushResult> {
      if (!input.email) return {};
      // No atomic contact upsert on v3 singles: search-before-create.
      const search = await api<{ results?: Array<{ id?: string }> }>(
        "POST",
        "/crm/v3/objects/contacts/search",
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "email",
                  operator: "EQ",
                  value: input.email,
                },
              ],
            },
          ],
          limit: 1,
        },
      );
      const existing = search.results?.[0]?.id;
      if (existing) return { contactId: existing };

      const created = await api<{ id?: string }>(
        "POST",
        "/crm/v3/objects/contacts",
        {
          properties: {
            email: input.email,
            ...(input.name ? { firstname: input.name } : {}),
            ...(input.phone ? { phone: input.phone } : {}),
          },
        },
      );
      return { contactId: created.id };
    },

    async verifyWebhook({ payload, headers, url }) {
      verifyAuthenticity({ payload, headers, url });
      return eventsFromWebhook(payload);
    },

    parseWebhook(payload: string): CrmStageEvent[] {
      // Unsigned parse (trusted contexts/tests): thin shells without hydrate.
      const parsed = JSON.parse(payload) as
        | HubspotWebhookEvent
        | HubspotWebhookEvent[];
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items.flatMap((evt) =>
        (evt.subscriptionType ?? "").startsWith("deal.") && evt.objectId
          ? [
              {
                dealId: evt.objectId.toString(),
                stageId: evt.propertyValue ?? "",
                occurredAt: evt.occurredAt
                  ? new Date(evt.occurredAt).toISOString()
                  : new Date().toISOString(),
                raw: evt,
              } satisfies CrmStageEvent,
            ]
          : [],
      );
    },

    async poll(cursor) {
      const since = cursor ?? new Date(0).toISOString();
      const result = await api<{
        results?: Array<{
          id?: string;
          properties?: Record<string, string | null>;
          updatedAt?: string;
        }>;
      }>("POST", "/crm/v3/objects/deals/search", {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "hs_lastmodifieddate",
                operator: "GT",
                value: since,
              },
            ],
          },
        ],
        properties: dealProperties,
        sorts: [
          { propertyName: "hs_lastmodifieddate", direction: "ASCENDING" },
        ],
        limit: 100,
      });

      const events: CrmStageEvent[] = [];
      let nextCursor = cursor ?? null;
      for (const deal of result.results ?? []) {
        const dealId = deal.id;
        const props = deal.properties ?? {};
        const stageId = props.dealstage ?? "";
        if (!dealId || !stageId) continue;
        const occurredAt =
          props.hs_lastmodifieddate ??
          deal.updatedAt ??
          new Date().toISOString();
        const amountRaw = props.amount;
        const amount = amountRaw ? Number(amountRaw) : Number.NaN;
        events.push({
          dealId,
          ...(props.pipeline ? { pipelineId: props.pipeline } : {}),
          stageId,
          ...(props.hs_is_closed_won === "true" ? { status: "won" } : {}),
          ...(Number.isFinite(amount)
            ? {
                value: {
                  amount,
                  ...(props.deal_currency_code
                    ? { currency: props.deal_currency_code }
                    : {}),
                },
              }
            : {}),
          occurredAt,
          raw: deal,
        });
        if (!nextCursor || occurredAt > nextCursor) nextCursor = occurredAt;
      }
      return { events, nextCursor };
    },

    async hydrate(dealId: string) {
      const hydrated = await hydrateDeal(dealId);
      return {
        stageId: hydrated.stageId,
        ...(hydrated.pipelineId ? { pipelineId: hydrated.pipelineId } : {}),
        ...(hydrated.status ? { status: hydrated.status } : {}),
        ...(hydrated.value ? { value: hydrated.value } : {}),
      };
    },
  });
}
