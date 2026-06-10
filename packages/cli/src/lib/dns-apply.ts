import type { DnsRecord } from "@hogsend/engine";
import type { DnsHostId } from "./dns.js";

/**
 * Best-effort DNS auto-apply for `hogsend domain add`. Supported hosts:
 * Cloudflare (CLOUDFLARE_API_TOKEN) and Vercel (VERCEL_TOKEN [+ VERCEL_TEAM_ID]).
 * These are CLI-PROCESS env vars only — deliberately NOT part of the engine's
 * validated env (the engine never writes DNS).
 */

/** True when the host supports auto-apply AND its credential is present. */
export function canAutoApply(host: DnsHostId, env: NodeJS.ProcessEnv): boolean {
  switch (host) {
    case "cloudflare":
      return Boolean(env.CLOUDFLARE_API_TOKEN);
    case "vercel":
      return Boolean(env.VERCEL_TOKEN);
    default:
      return false;
  }
}

export interface ApplyRecordsOptions {
  host: DnsHostId;
  domain: string;
  records: DnsRecord[];
  env: NodeJS.ProcessEnv;
  /** Injectable fetch for tests — NEVER hit the real APIs in CI. */
  fetchImpl?: typeof fetch;
}

export interface ApplyRecordsResult {
  applied: DnsRecord[];
  skipped: DnsRecord[];
  errors: string[];
}

/** Cloudflare error codes meaning "an identical record already exists". */
const CF_DUPLICATE_CODES = new Set([81057, 81053]);

/**
 * Registrable domain heuristic for zone lookup: the last two labels. Good
 * enough for the auto-apply happy path (mail.mysite.com → mysite.com); exotic
 * public-suffix domains fall back to the error path and manual records.
 */
function registrableDomain(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return domain;
  return labels.slice(-2).join(".");
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function applyCloudflare(
  opts: ApplyRecordsOptions,
  fetchImpl: typeof fetch,
): Promise<ApplyRecordsResult> {
  const result: ApplyRecordsResult = { applied: [], skipped: [], errors: [] };
  const token = opts.env.CLOUDFLARE_API_TOKEN ?? "";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Resolve the zone id for the registrable domain.
  const zoneName = registrableDomain(opts.domain);
  let zoneId: string | undefined;
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`,
      { headers },
    );
    const body = (await parseJson(res)) as
      | { result?: Array<{ id?: string }> }
      | undefined;
    zoneId = body?.result?.[0]?.id;
  } catch (cause) {
    // `skipped` is reserved for "already present" — a zone failure means
    // NOTHING was attempted, so it surfaces as a single error.
    result.errors.push(
      `Cloudflare zone lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return result;
  }
  if (!zoneId) {
    result.errors.push(
      `could not resolve a Cloudflare zone for ${zoneName} — is the domain on this account?`,
    );
    return result;
  }

  for (const record of opts.records) {
    try {
      const res = await fetchImpl(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: record.type,
            name: record.name,
            content: record.value,
            ttl: record.ttl ?? 1, // 1 = automatic
            ...(record.priority !== undefined
              ? { priority: record.priority }
              : {}),
            // NEVER proxy mail-verification records — orange-cloud breaks them.
            proxied: false,
          }),
        },
      );
      if (res.ok) {
        result.applied.push(record);
        continue;
      }
      const body = (await parseJson(res)) as
        | { errors?: Array<{ code?: number; message?: string }> }
        | undefined;
      const codes = (body?.errors ?? []).map((e) => e.code ?? 0);
      if (codes.some((code) => CF_DUPLICATE_CODES.has(code))) {
        // Identical record already present — idempotent success.
        result.skipped.push(record);
        continue;
      }
      const message =
        body?.errors?.[0]?.message ?? `Cloudflare API status ${res.status}`;
      result.errors.push(`${record.type} ${record.name}: ${message}`);
    } catch (cause) {
      result.errors.push(
        `${record.type} ${record.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return result;
}

async function applyVercel(
  opts: ApplyRecordsOptions,
  fetchImpl: typeof fetch,
): Promise<ApplyRecordsResult> {
  const result: ApplyRecordsResult = { applied: [], skipped: [], errors: [] };
  const token = opts.env.VERCEL_TOKEN ?? "";
  const teamId = opts.env.VERCEL_TEAM_ID;
  const base = `https://api.vercel.com/v2/domains/${encodeURIComponent(opts.domain)}/records`;
  const url = teamId ? `${base}?teamId=${encodeURIComponent(teamId)}` : base;

  for (const record of opts.records) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          value: record.value,
          ...(record.ttl !== undefined ? { ttl: record.ttl } : {}),
          ...(record.priority !== undefined
            ? { mxPriority: record.priority }
            : {}),
        }),
      });
      if (res.ok) {
        result.applied.push(record);
        continue;
      }
      const body = (await parseJson(res)) as
        | { error?: { code?: string; message?: string } }
        | undefined;
      const code = body?.error?.code ?? "";
      const message = body?.error?.message ?? "";
      if (/duplicate/i.test(code) || /already exists/i.test(message)) {
        result.skipped.push(record);
        continue;
      }
      result.errors.push(
        `${record.type} ${record.name}: ${message || `Vercel API status ${res.status}`}`,
      );
    } catch (cause) {
      result.errors.push(
        `${record.type} ${record.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return result;
}

/**
 * Apply the DNS records via the host's API. NEVER throws — failures land in
 * `errors`, "identical record exists" responses land in `skipped`, so the
 * caller can always render a complete applied/skipped/errors report.
 */
export async function applyRecords(
  opts: ApplyRecordsOptions,
): Promise<ApplyRecordsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!canAutoApply(opts.host, opts.env)) {
    return {
      applied: [],
      skipped: [...opts.records],
      errors: [
        `auto-apply is not available for ${opts.host} — add the records manually in your DNS panel`,
      ],
    };
  }

  if (opts.host === "cloudflare") return applyCloudflare(opts, fetchImpl);
  return applyVercel(opts, fetchImpl);
}
