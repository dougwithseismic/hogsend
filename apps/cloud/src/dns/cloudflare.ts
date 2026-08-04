import {
  type DnsCapacity,
  DnsError,
  type DnsProvider,
  DnsRecordConflictError,
  type DnsRecordHandle,
  type DnsRecordSpec,
} from "./types";

/**
 * Cloudflare DNS, over the v4 REST API.
 *
 * Dependency-free `fetch` + JSON, for the same reasons the Railway client is:
 * three endpoints, no pagination worth a library, and a vendor SDK would cost a
 * dependency to save nothing.
 *
 * Three things it owns, because nothing above the seam may know them:
 *  - the endpoint, the zone and the auth header,
 *  - which vendor status codes are worth retrying,
 *  - the translation of every failure into `DnsError`.
 */

export const CLOUDFLARE_DNS_ID = "cloudflare";
export const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";

/**
 * Records are written one per instance during provisioning, not in bursts, so
 * this is a smaller budget than the substrate's 8. It covers a rate-limit blip
 * and a transient 5xx; anything longer is the provisioning sweep's job.
 */
export const CLOUDFLARE_MAX_ATTEMPTS = 4;
export const CLOUDFLARE_BACKOFF_BASE_MS = 500;

export interface CloudflareHttpRequest {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  /** Already-serialised JSON body; absent on GET and DELETE. */
  body?: string;
}

export interface CloudflareHttpResponse {
  status: number;
  body: string;
}

/**
 * The injectable wire, narrower than `fetch` on purpose: a test supplies an
 * in-memory responder, and no test reaches the network by forgetting a stub.
 */
export type CloudflareTransport = (
  request: CloudflareHttpRequest,
) => Promise<CloudflareHttpResponse>;

export type SleepFn = (ms: number) => Promise<void>;

export interface CloudflareDnsOptions {
  /** Zone-scoped API token with DNS edit. NEVER logged. */
  token: string;
  zoneId: string;
  /**
   * The zone's own name, e.g. `hogsend.com`. Used only to reject a hostname
   * that is not inside it — a caller passing someone else's domain is a bug we
   * refuse locally rather than send to the vendor.
   */
  zoneName: string;
  transport?: CloudflareTransport;
  sleep?: SleepFn;
}

interface CloudflareRecord {
  id: string;
  name: string;
  content: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { code?: number; message?: string }[];
  result_info?: { total_count?: number };
}

/**
 * Statuses worth trying again. 429 is the documented rate limit; 5xx is the
 * vendor being briefly unwell. Everything else — 400 (malformed), 403 (token
 * scope), 404 (wrong zone) — is a misconfiguration that will fail identically
 * on every retry, so it parks the stack instead of burning the budget.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * A vendor HTTP failure, carrying the status so `deleteRecord` can recognise a
 * 404 without matching on a message string. Local to this file: the status is a
 * Cloudflare detail and must not cross the seam.
 */
class CloudflareHttpError extends DnsError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message, { retryable: isRetryableStatus(status) });
  }
}

export class CloudflareDns implements DnsProvider {
  readonly id = CLOUDFLARE_DNS_ID;

  private readonly token: string;
  private readonly zoneId: string;
  private readonly zoneName: string;
  private readonly transport: CloudflareTransport;
  private readonly sleep: SleepFn;

  constructor(options: CloudflareDnsOptions) {
    this.token = options.token;
    this.zoneId = options.zoneId;
    this.zoneName = options.zoneName;
    this.transport = options.transport ?? defaultTransport;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async ensureRecord(spec: DnsRecordSpec): Promise<DnsRecordHandle> {
    this.assertInZone(spec.hostname);

    const existing = await this.findByName(spec.hostname);
    if (existing) {
      if (existing.content !== spec.target) {
        throw new DnsRecordConflictError(spec.hostname, existing.content);
      }
      return { id: existing.id, hostname: existing.name };
    }

    const created = await this.request<CloudflareRecord>({
      method: "POST",
      path: `/zones/${this.zoneId}/dns_records`,
      body: {
        type: "CNAME",
        name: spec.hostname,
        content: spec.target,
        // DNS-only, never proxied. Railway terminates TLS for these hostnames,
        // and a proxied record breaks its Let's Encrypt issuance outright.
        proxied: false,
      },
    });

    return { id: created.id, hostname: created.name };
  }

  async deleteRecord(handle: Pick<DnsRecordHandle, "id">): Promise<void> {
    try {
      await this.request<{ id: string }>({
        method: "DELETE",
        path: `/zones/${this.zoneId}/dns_records/${handle.id}`,
      });
    } catch (error) {
      // Already gone is the outcome we wanted. Teardown re-runs, and a second
      // destroy must not fail on the work the first one finished.
      if (error instanceof CloudflareHttpError && error.status === 404) return;
      throw error;
    }
  }

  async readCapacity(): Promise<DnsCapacity> {
    const response = await this.requestEnvelope<CloudflareRecord[]>({
      method: "GET",
      // per_page=1 because only the count matters; the rows are never read.
      path: `/zones/${this.zoneId}/dns_records?per_page=1`,
    });

    return {
      used: response.result_info?.total_count ?? response.result.length,
      // Cloudflare does not report the plan's record cap on this endpoint, and
      // a guessed ceiling is worse than an honest unknown.
      limit: null,
    };
  }

  /**
   * A hostname outside our zone is a caller bug, and one worth catching here:
   * sent to Cloudflare it would come back as an opaque 400, and the operator
   * reading the parked stack would have to guess why.
   */
  private assertInZone(hostname: string): void {
    if (hostname !== this.zoneName && !hostname.endsWith(`.${this.zoneName}`)) {
      throw new DnsError(
        `"${hostname}" is not inside the zone "${this.zoneName}"`,
      );
    }
  }

  private async findByName(
    hostname: string,
  ): Promise<CloudflareRecord | undefined> {
    const records = await this.request<CloudflareRecord[]>({
      method: "GET",
      path: `/zones/${this.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
    });
    return records[0];
  }

  private async request<T>(input: {
    method: CloudflareHttpRequest["method"];
    path: string;
    body?: unknown;
  }): Promise<T> {
    return (await this.requestEnvelope<T>(input)).result;
  }

  private async requestEnvelope<T>(input: {
    method: CloudflareHttpRequest["method"];
    path: string;
    body?: unknown;
  }): Promise<CloudflareEnvelope<T>> {
    let lastError: DnsError | undefined;

    for (let attempt = 1; attempt <= CLOUDFLARE_MAX_ATTEMPTS; attempt += 1) {
      const response = await this.transport({
        url: `${CLOUDFLARE_API_URL}${input.path}`,
        method: input.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
      });

      if (response.status >= 200 && response.status < 300) {
        const envelope = parseEnvelope<T>(response.body);
        if (envelope.success) return envelope;
        // A 200 with `success: false` is Cloudflare reporting a semantic
        // refusal. It will refuse identically next time, so it does not retry.
        throw new DnsError(
          `Cloudflare refused the request: ${describeErrors(envelope)}`,
        );
      }

      lastError = new CloudflareHttpError(
        response.status,
        `Cloudflare returned ${response.status}: ${response.body.slice(0, 300)}`,
      );
      if (!lastError.retryable) throw lastError;

      if (attempt < CLOUDFLARE_MAX_ATTEMPTS) {
        await this.sleep(CLOUDFLARE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }

    throw (
      lastError ??
      new DnsError("Cloudflare request failed with no response", {
        retryable: true,
      })
    );
  }
}

function parseEnvelope<T>(body: string): CloudflareEnvelope<T> {
  try {
    return JSON.parse(body) as CloudflareEnvelope<T>;
  } catch (error) {
    throw new DnsError("Cloudflare returned a body that is not JSON", {
      cause: error,
    });
  }
}

function describeErrors(envelope: CloudflareEnvelope<unknown>): string {
  const messages = (envelope.errors ?? [])
    .map((entry) => entry.message ?? String(entry.code ?? "unknown"))
    .filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : "no reason given";
}

const defaultTransport: CloudflareTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return { status: response.status, body: await response.text() };
};
