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
 * Attio `CrmProvider`.
 *
 * The reference value-by-fetch CRM: Attio's `record.*` webhooks are THIN —
 * they say which record changed, never what it now holds — so
 * `verifyWebhook` hydrates each deal event through the REST API before
 * emitting a `CrmStageEvent`. Webhooks are signed (HMAC-SHA256 of the raw
 * body in the `attio-signature` header); verification fails closed.
 *
 * Coordination note: `feat/sources-prospects-p1` builds an Attio CONTACT
 * source (people in) + write-back on the same API surface. When it merges,
 * the HTTP client here should fold into that transport — tracked in the
 * plan's §4.5 seam note.
 *
 * NOTE (verify-before-rely): shapes follow docs.attio.com; a live workspace
 * pass is the seam ask before production use.
 */

export interface AttioProviderConfig {
  /** Workspace API key (or OAuth access token). */
  apiKey: string;
  /** Webhook signing secret (from the Attio webhook subscription). */
  webhookSecret: string;
  /** The deal object's api_slug. Default "deals". */
  dealObject?: string;
  /** The stage attribute's api_slug on the deal object. Default "stage". */
  stageAttribute?: string;
  /** The value attribute's api_slug on the deal object. Default "value". */
  valueAttribute?: string;
  /** People-reference attribute on the deal, for email recovery. Default "associated_people". */
  peopleAttribute?: string;
  /** Override the API origin (tests). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
}

interface AttioWebhookEvent {
  event_type?: string;
  id?: { workspace_id?: string; object_id?: string; record_id?: string };
  occurred_at?: string;
  [key: string]: unknown;
}

type AttioValues = Record<string, Array<Record<string, unknown>> | undefined>;

function firstValue(
  values: AttioValues,
  slug: string,
): Record<string, unknown> | undefined {
  const arr = values[slug];
  return Array.isArray(arr) ? arr[0] : undefined;
}

export function createAttioProvider(config: AttioProviderConfig): CrmProvider {
  const base = (config.baseUrl ?? "https://api.attio.com").replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? fetch;
  const dealObject = config.dealObject ?? "deals";
  const stageAttribute = config.stageAttribute ?? "stage";
  const valueAttribute = config.valueAttribute ?? "value";
  const peopleAttribute = config.peopleAttribute ?? "associated_people";

  async function api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Attio ${method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Read a deal record's current stage/value (+ contact email, best-effort). */
  async function hydrateDeal(recordId: string): Promise<{
    stageId: string;
    stageName?: string;
    status?: "open" | "won" | "lost";
    value?: CrmMoney;
    email?: string;
    contactId?: string;
  }> {
    const record = await api<{
      data?: { values?: AttioValues };
    }>("GET", `/v2/objects/${dealObject}/records/${recordId}`);
    const values = record.data?.values ?? {};

    const stage = firstValue(values, stageAttribute);
    const stageStatus = (stage?.status ?? {}) as Record<string, unknown>;
    const stageTitle =
      (stageStatus.title as string | undefined) ??
      (stage?.option as Record<string, unknown> | undefined)?.title;
    const stageId =
      ((stageStatus.id as Record<string, unknown> | undefined)
        ?.status_id as string) ??
      (typeof stageTitle === "string" ? stageTitle : "");

    const valueEntry = firstValue(values, valueAttribute);
    const amount = valueEntry?.currency_value as number | undefined;
    const currency = valueEntry?.currency_code as string | undefined;

    const person = firstValue(values, peopleAttribute);
    const personRecordId = person?.target_record_id as string | undefined;
    let email: string | undefined;
    if (personRecordId) {
      try {
        const personRecord = await api<{ data?: { values?: AttioValues } }>(
          "GET",
          `/v2/objects/people/records/${personRecordId}`,
        );
        const emailEntry = firstValue(
          personRecord.data?.values ?? {},
          "email_addresses",
        );
        const addr = emailEntry?.email_address;
        if (typeof addr === "string") email = addr;
      } catch {
        // Best-effort: the crm_links alias resolves repeat events anyway.
      }
    }

    return {
      stageId,
      ...(typeof stageTitle === "string" ? { stageName: stageTitle } : {}),
      ...(amount !== undefined && Number.isFinite(amount)
        ? { value: { amount, ...(currency ? { currency } : {}) } }
        : {}),
      ...(email ? { email } : {}),
      ...(personRecordId ? { contactId: personRecordId } : {}),
    };
  }

  async function eventsFromWebhook(payload: string): Promise<CrmStageEvent[]> {
    const parsed = JSON.parse(payload) as { events?: AttioWebhookEvent[] };
    const out: CrmStageEvent[] = [];
    for (const evt of parsed.events ?? []) {
      const type = evt.event_type ?? "";
      if (!type.startsWith("record.")) continue;
      const recordId = evt.id?.record_id;
      if (!recordId) continue;
      const hydrated = await hydrateDeal(recordId);
      if (!hydrated.stageId) continue;
      out.push({
        dealId: recordId,
        ...(hydrated.contactId ? { contactId: hydrated.contactId } : {}),
        ...(hydrated.email ? { email: hydrated.email } : {}),
        stageId: hydrated.stageId,
        ...(hydrated.stageName ? { stageName: hydrated.stageName } : {}),
        ...(hydrated.status ? { status: hydrated.status } : {}),
        ...(hydrated.value ? { value: hydrated.value } : {}),
        occurredAt: evt.occurred_at ?? new Date().toISOString(),
        raw: evt,
      });
    }
    return out;
  }

  return defineCrmProvider({
    meta: {
      id: "attio",
      name: "Attio",
      description:
        "Attio deals sync — signed thin webhooks hydrated through the REST API.",
    },
    capabilities: {
      auth: "apiKey",
      nativeStageWebhook: true,
      valueInWebhookPayload: false,
      atomicUpsert: true,
    },

    async pushLead(
      input: CrmLeadInput,
      _opts: { idempotencyKey: string },
    ): Promise<CrmPushResult> {
      if (!input.email) return {};
      // Person assert — idempotent on the email matching attribute.
      const person = await api<{ data?: { id?: { record_id?: string } } }>(
        "PUT",
        "/v2/objects/people/records?matching_attribute=email_addresses",
        {
          data: {
            values: {
              email_addresses: [{ email_address: input.email }],
              ...(input.name ? { name: [{ full_name: input.name }] } : {}),
            },
          },
        },
      );
      return { contactId: person.data?.id?.record_id };
    },

    async verifyWebhook({ payload, headers }) {
      const presented =
        headers["attio-signature"] ?? headers["x-attio-signature"] ?? "";
      const expected = createHmac("sha256", config.webhookSecret)
        .update(payload)
        .digest("hex");
      const a = Buffer.from(presented);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error("Attio webhook signature mismatch");
      }
      return eventsFromWebhook(payload);
    },

    parseWebhook(payload: string): CrmStageEvent[] {
      // Unsigned parse is only used in trusted contexts/tests; it cannot
      // hydrate synchronously, so it emits stage-less SHELLS callers must
      // hydrate themselves. Prefer verifyWebhook.
      const parsed = JSON.parse(payload) as { events?: AttioWebhookEvent[] };
      return (parsed.events ?? [])
        .filter((e) => (e.event_type ?? "").startsWith("record."))
        .flatMap((e) =>
          e.id?.record_id
            ? [
                {
                  dealId: e.id.record_id,
                  stageId: "",
                  occurredAt: e.occurred_at ?? new Date().toISOString(),
                  raw: e,
                } satisfies CrmStageEvent,
              ]
            : [],
        );
    },

    async hydrate(dealId: string) {
      const hydrated = await hydrateDeal(dealId);
      return {
        stageId: hydrated.stageId,
        ...(hydrated.status ? { status: hydrated.status } : {}),
        ...(hydrated.value ? { value: hydrated.value } : {}),
      };
    },
  });
}
