import type {
  DnsRecord,
  DnsRecordPurpose,
  DnsRecordStatus,
  DomainStatus,
  DomainsCapability,
  DomainVerificationState,
} from "@hogsend/core";

/**
 * The Resend implementation of the {@link DomainsCapability} contract — a dumb
 * wire over the Resend Domains REST API (`https://api.resend.com/domains`).
 * Plain `fetch` with the bearer token; all caching/policy lives in the engine's
 * `DomainStatusService`, never here.
 */
export interface ResendDomainsConfig {
  apiKey: string;
}

const BASE_URL = "https://api.resend.com";

/** Resend's per-record verification statuses → neutral {@link DnsRecordStatus}. */
const RECORD_STATUS: Record<string, DnsRecordStatus> = {
  verified: "verified",
  failure: "failed",
  not_started: "pending",
  pending: "pending",
  temporary_failure: "pending",
};

/** Resend's domain statuses → neutral {@link DomainVerificationState}. */
const DOMAIN_STATE: Record<string, DomainVerificationState> = {
  verified: "verified",
  failure: "failed",
  not_started: "pending",
  pending: "pending",
  temporary_failure: "pending",
};

/** A record as Resend's `GET /domains/:id` reports it. */
interface ResendRecord {
  record?: string; // "SPF" | "DKIM"
  type?: string; // "TXT" | "CNAME" | "MX"
  name?: string;
  value?: string;
  ttl?: string | number;
  priority?: number;
  status?: string;
}

interface ResendDomainPayload {
  id?: string;
  name?: string;
  status?: string;
  records?: ResendRecord[];
}

function recordPurpose(r: ResendRecord): DnsRecordPurpose {
  const kind = (r.record ?? "").toUpperCase();
  if (kind === "SPF") return "spf";
  if (kind === "DKIM") return "dkim";
  if ((r.type ?? "").toUpperCase() === "MX") return "mx";
  return "other";
}

function toDnsRecord(r: ResendRecord): DnsRecord {
  const type = (r.type ?? "TXT").toUpperCase();
  return {
    type: type === "CNAME" ? "CNAME" : type === "MX" ? "MX" : "TXT",
    name: r.name ?? "",
    value: r.value ?? "",
    ...(typeof r.ttl === "number" ? { ttl: r.ttl } : {}),
    ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
    purpose: recordPurpose(r),
    status: RECORD_STATUS[r.status ?? ""] ?? "unknown",
  };
}

function toDomainStatus(payload: ResendDomainPayload): DomainStatus {
  return {
    domain: payload.name ?? "",
    state: DOMAIN_STATE[payload.status ?? ""] ?? "pending",
    records: (payload.records ?? []).map(toDnsRecord),
    providerId: "resend",
    checkedAt: new Date().toISOString(),
    raw: payload,
  };
}

function errorMessage(status: number, body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
  ) {
    return `Resend domains API ${status}: ${(body as { message: string }).message}`;
  }
  return `Resend domains API request failed with status ${status}`;
}

/** Build the Resend {@link DomainsCapability}. */
export function createResendDomains(
  config: ResendDomainsConfig,
): DomainsCapability {
  const api = async (
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ ok: boolean; status: number; body: unknown }> => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  };

  /** Resolve a domain name → Resend domain id via `GET /domains`. */
  const findId = async (domain: string): Promise<string | null> => {
    const res = await api("/domains");
    if (!res.ok) throw new Error(errorMessage(res.status, res.body));
    const data =
      res.body && typeof res.body === "object" && "data" in res.body
        ? (res.body as { data: ResendDomainPayload[] }).data
        : [];
    const match = (data ?? []).find((d) => d.name === domain);
    return match?.id ?? null;
  };

  /** Fetch + normalize `GET /domains/:id`. */
  const getById = async (id: string): Promise<DomainStatus> => {
    const res = await api(`/domains/${id}`);
    if (!res.ok) throw new Error(errorMessage(res.status, res.body));
    return toDomainStatus(res.body as ResendDomainPayload);
  };

  const get = async (domain: string): Promise<DomainStatus | null> => {
    const id = await findId(domain);
    if (id === null) return null;
    return getById(id);
  };

  return {
    async create(domain: string): Promise<DomainStatus> {
      const res = await api("/domains", {
        method: "POST",
        body: { name: domain },
      });
      if (res.ok) return toDomainStatus(res.body as ResendDomainPayload);

      // Idempotent create: an "already exists" conflict falls through to lookup.
      const message =
        res.body && typeof res.body === "object" && "message" in res.body
          ? String((res.body as { message: unknown }).message)
          : "";
      if (res.status === 409 || /already exists/i.test(message)) {
        const existing = await get(domain);
        if (existing) return existing;
      }
      throw new Error(errorMessage(res.status, res.body));
    },

    get,

    async records(domain: string): Promise<DnsRecord[]> {
      const status = await get(domain);
      return status?.records ?? [];
    },

    async verify(domain: string): Promise<DomainStatus> {
      const id = await findId(domain);
      if (id === null) {
        throw new Error(
          `domain "${domain}" is not registered with Resend — run create first`,
        );
      }
      const res = await api(`/domains/${id}/verify`, { method: "POST" });
      if (!res.ok) throw new Error(errorMessage(res.status, res.body));
      // The verify response carries no records — re-fetch the fresh status.
      return getById(id);
    },
  };
}
