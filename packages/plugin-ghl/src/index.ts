import { timingSafeEqual } from "node:crypto";
import {
  type CrmLeadInput,
  type CrmMoney,
  type CrmProvider,
  type CrmPushResult,
  type CrmStageEvent,
  defineCrmProvider,
} from "@hogsend/core";

/**
 * GoHighLevel `CrmProvider` (docs/revenue-attribution-plan.md §4.4).
 *
 * The reference value-in-payload CRM: GHL's opportunity webhooks carry
 * `monetaryValue`, `pipelineId`, `pipelineStageId`, and `status` directly, so
 * no hydrate round-trip is needed on the hot path. API v2
 * (services.leadconnectorhq.com) authenticates with a Private Integration
 * Token or an OAuth access token — both ride the same `Authorization` header.
 *
 * Webhook authenticity: GHL WORKFLOW webhooks carry no signature. The
 * provider therefore requires a shared secret appended to the webhook URL you
 * configure in GHL (`?secret=…`) or sent as an `x-ghl-secret` header via a
 * custom-header action. Fail-closed: with `webhookSecret` configured, a
 * mismatch throws (401 at the route); WITHOUT one configured, every webhook
 * is rejected — set the secret.
 *
 * NOTE (verify-before-rely, plan §4): endpoint shapes follow GHL's published
 * v2 docs; a live sandbox pass is the seam ask before production use.
 */

export interface GhlProviderConfig {
  /** Private Integration Token (or OAuth access token). */
  accessToken: string;
  /** The GHL location (sub-account) id leads are pushed into. */
  locationId: string;
  /** Shared secret expected on inbound webhooks (`?secret=` or `x-ghl-secret`). */
  webhookSecret: string;
  /** Pipeline the lead push creates opportunities in (optional). */
  defaultPipelineId?: string;
  /** Stage new opportunities start in (optional; GHL default otherwise). */
  defaultStageId?: string;
  /** Override the API origin (tests). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
}

const API_VERSION_HEADER = "2021-07-28";

interface GhlOpportunityPayload {
  id?: string;
  contact_id?: string;
  contactId?: string;
  email?: string;
  pipelineId?: string;
  pipleineId?: string; // GHL has shipped this typo in some payload versions
  pipelineStageId?: string;
  pipelineStageName?: string;
  status?: string;
  monetaryValue?: number | string;
  dateUpdated?: string;
  dateAdded?: string;
  [key: string]: unknown;
}

function toMoney(raw: number | string | undefined): CrmMoney | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const amount = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(amount)) return undefined;
  // GHL opportunities carry no currency — the location's currency applies;
  // leave currency unset and let the deployment's default reporting handle it.
  return { amount };
}

function toStatus(raw: string | undefined): CrmStageEvent["status"] {
  if (raw === "won") return "won";
  if (raw === "lost" || raw === "abandoned") return "lost";
  if (raw === "open") return "open";
  return undefined;
}

/** Normalize one GHL opportunity object (webhook or API shape) to an event. */
function opportunityToEvent(o: GhlOpportunityPayload): CrmStageEvent | null {
  const dealId = o.id;
  const stageId = o.pipelineStageId;
  if (!dealId || !stageId) return null;
  return {
    dealId,
    contactId: o.contact_id ?? o.contactId,
    email: typeof o.email === "string" && o.email ? o.email : undefined,
    pipelineId: o.pipelineId ?? o.pipleineId,
    stageId,
    stageName: o.pipelineStageName,
    status: toStatus(o.status),
    value: toMoney(o.monetaryValue),
    occurredAt: o.dateUpdated ?? o.dateAdded ?? new Date().toISOString(),
    raw: o,
  };
}

export function createGhlProvider(config: GhlProviderConfig): CrmProvider {
  const base = (
    config.baseUrl ?? "https://services.leadconnectorhq.com"
  ).replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? fetch;

  async function api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        Version: API_VERSION_HEADER,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `GHL ${method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  function verifySecret(headers: Record<string, string>, url: string): void {
    const fromHeader = headers["x-ghl-secret"];
    let fromQuery: string | null = null;
    try {
      fromQuery = new URL(url).searchParams.get("secret");
    } catch {
      // no usable URL — header-only
    }
    const presented = fromHeader ?? fromQuery;
    const a = Buffer.from(presented ?? "");
    const b = Buffer.from(config.webhookSecret ?? "");
    if (
      !config.webhookSecret ||
      !presented ||
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    ) {
      throw new Error("GHL webhook secret mismatch");
    }
  }

  return defineCrmProvider({
    meta: {
      id: "ghl",
      name: "GoHighLevel",
      description:
        "GoHighLevel opportunities sync — value-in-payload stage webhooks + poll.",
    },
    capabilities: {
      auth: "apiKey",
      nativeStageWebhook: true,
      valueInWebhookPayload: true,
      atomicUpsert: true,
    },

    async pushLead(
      input: CrmLeadInput,
      opts: { idempotencyKey: string },
    ): Promise<CrmPushResult> {
      // Contact upsert is atomic in GHL (email/phone dedup server-side).
      const contact = await api<{ contact?: { id?: string } }>(
        "POST",
        "/contacts/upsert",
        {
          locationId: config.locationId,
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.properties
            ? {
                customFields: Object.entries(input.properties).map(
                  ([key, value]) => ({ key, field_value: String(value) }),
                ),
              }
            : {}),
        },
      );
      const contactId = contact.contact?.id;
      if (!contactId) return {};

      if (!config.defaultPipelineId) return { contactId };

      const opportunity = await api<{ opportunity?: { id?: string } }>(
        "POST",
        "/opportunities/",
        {
          locationId: config.locationId,
          contactId,
          pipelineId: config.defaultPipelineId,
          ...(config.defaultStageId
            ? { pipelineStageId: config.defaultStageId }
            : {}),
          name: input.name ?? input.email ?? opts.idempotencyKey,
          status: "open",
          ...(input.value ? { monetaryValue: input.value.amount } : {}),
        },
      );
      return { contactId, dealId: opportunity.opportunity?.id };
    },

    verifyWebhook({ payload, headers, url }) {
      verifySecret(headers, url);
      return this.parseWebhook(payload);
    },

    parseWebhook(payload: string): CrmStageEvent[] {
      const parsed = JSON.parse(payload) as
        | GhlOpportunityPayload
        | GhlOpportunityPayload[];
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items
        .map(opportunityToEvent)
        .filter((e): e is CrmStageEvent => e !== null);
    },

    async poll(cursor) {
      // Opportunity search ordered by last update; the cursor is the newest
      // `dateUpdated` seen. Overlap on equality is safe — the spine dedups.
      const query = new URLSearchParams({
        location_id: config.locationId,
        limit: "100",
        order: "added_desc",
      });
      if (cursor) query.set("date", cursor);
      const result = await api<{
        opportunities?: GhlOpportunityPayload[];
      }>("GET", `/opportunities/search?${query.toString()}`);
      const events = (result.opportunities ?? [])
        .map(opportunityToEvent)
        .filter((e): e is CrmStageEvent => e !== null)
        .filter((e) => !cursor || e.occurredAt > cursor);
      const nextCursor = events.reduce(
        (max, e) => (e.occurredAt > max ? e.occurredAt : max),
        cursor ?? "",
      );
      return { events, nextCursor: nextCursor || null };
    },

    async hydrate(dealId: string) {
      const result = await api<{ opportunity?: GhlOpportunityPayload }>(
        "GET",
        `/opportunities/${encodeURIComponent(dealId)}`,
      );
      const o = result.opportunity ?? ({} as GhlOpportunityPayload);
      return {
        stageId: o.pipelineStageId ?? "",
        pipelineId: o.pipelineId,
        status: toStatus(o.status),
        value: toMoney(o.monetaryValue),
      };
    },
  });
}
