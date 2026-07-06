import type {
  ContactImportRow,
  SuppressionImportRow,
} from "./import-shared.js";
import { parseCsvRecords } from "./import-shared.js";

export type CioRegion = "us" | "eu";

export function cioBaseUrl(region: CioRegion): string {
  return region === "eu"
    ? "https://api-eu.customer.io"
    : "https://api.customer.io";
}

/**
 * The "export everyone" filter. The exports API REQUIRES a `filters` body and
 * documents no export-all shorthand, so we build a tautology from documented
 * operators: email exists OR email does not exist.
 */
export const CIO_EVERYONE_FILTER = {
  or: [
    { attribute: { field: "email", operator: "exists" } },
    { not: { attribute: { field: "email", operator: "exists" } } },
  ],
};

/** Identity/subscription columns of the CIO people export CSV. */
const CIO_NON_PROPERTY_COLUMNS = new Set([
  "id",
  "cio_id",
  "email",
  "unsubscribed",
]);

/** CIO's reserved `unsubscribed` attribute tolerates "true"/1/etc. */
function isTruthyFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "t" || v === "yes";
}

/**
 * Map a Customer.io people-export CSV to Hogsend import rows:
 *
 * - `id` (preferred) or `cio_id` → `externalId`, `email` → `email`
 * - other attribute columns → `properties` (string values; CSV carries no types)
 * - the reserved `unsubscribed` attribute, when truthy, additionally yields a
 *   suppression row with reason `unsubscribed`
 */
export function mapCioCsv(csv: string): {
  contacts: ContactImportRow[];
  suppressions: SuppressionImportRow[];
} {
  const { records } = parseCsvRecords(csv);

  const contacts: ContactImportRow[] = [];
  const suppressions: SuppressionImportRow[] = [];

  for (const record of records) {
    const email = record.email?.trim().toLowerCase() || undefined;
    const externalId = record.id?.trim() || record.cio_id?.trim() || undefined;
    if (!email && !externalId) continue;

    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (CIO_NON_PROPERTY_COLUMNS.has(key) || value === "") continue;
      properties[key] = value;
    }

    contacts.push({
      ...(externalId ? { externalId } : {}),
      ...(email ? { email } : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
    });

    if (email && isTruthyFlag(record.unsubscribed)) {
      suppressions.push({
        email,
        reason: "unsubscribed",
        ...(externalId ? { externalId } : {}),
      });
    }
  }

  return { contacts, suppressions };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function readJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${label} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Run the async people export: create the job (POST /v1/exports/customers),
 * poll GET /v1/exports/{id} until `status` is done, then download the CSV via
 * the signed URL from GET /v1/exports/{id}/download IMMEDIATELY (it expires
 * after 15 minutes).
 */
export async function runCioExport(opts: {
  appKey: string;
  baseUrl: string;
  segmentId?: number;
  fetch: FetchLike;
  onPoll?: (status: string) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
}): Promise<string> {
  const { appKey, baseUrl } = opts;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = opts.pollIntervalMs ?? 5000;
  const maxPolls = opts.maxPolls ?? 240; // 20 minutes at the default interval
  const headers = {
    Authorization: `Bearer ${appKey}`,
    "Content-Type": "application/json",
  };

  const filters = opts.segmentId
    ? { segment: { id: opts.segmentId } }
    : CIO_EVERYONE_FILTER;

  const created = await readJson<{ export: { id: number; status: string } }>(
    await opts.fetch(`${baseUrl}/v1/exports/customers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filters }),
    }),
    "Customer.io export create",
  );

  const exportId = created.export.id;
  let status = created.export.status;

  for (let polls = 0; status !== "done"; polls++) {
    if (status === "failed") {
      throw new Error(`Customer.io export ${exportId} failed`);
    }
    if (polls >= maxPolls) {
      throw new Error(
        `Customer.io export ${exportId} did not finish after ${maxPolls} polls (last status: ${status})`,
      );
    }
    opts.onPoll?.(status);
    await sleep(interval);
    const polled = await readJson<{ export: { status: string } }>(
      await opts.fetch(`${baseUrl}/v1/exports/${exportId}`, {
        headers: { Authorization: `Bearer ${appKey}` },
      }),
      "Customer.io export poll",
    );
    status = polled.export.status;
  }

  const download = await readJson<{ url: string }>(
    await opts.fetch(`${baseUrl}/v1/exports/${exportId}/download`, {
      headers: { Authorization: `Bearer ${appKey}` },
    }),
    "Customer.io export download",
  );

  // The signed URL is public (no auth header) and expires in 15 minutes.
  const file = await opts.fetch(download.url);
  if (!file.ok) {
    throw new Error(`Customer.io export file download failed (${file.status})`);
  }
  return await file.text();
}

/**
 * Page GET /v1/esp/suppression/{bounces|spam_reports} (limit max 1000,
 * offset pagination; plaintext emails). Only available when email is delivered
 * through Customer.io's ESP — callers should catch and warn, not abort.
 */
export async function fetchCioEspSuppressions(opts: {
  appKey: string;
  baseUrl: string;
  type: "bounces" | "spam_reports";
  fetch: FetchLike;
  limit?: number;
}): Promise<string[]> {
  const limit = opts.limit ?? 1000;
  const emails: string[] = [];

  for (let offset = 0; ; offset += limit) {
    const page = await readJson<{
      suppressions?: Array<{ email: string }>;
    }>(
      await opts.fetch(
        `${opts.baseUrl}/v1/esp/suppression/${opts.type}?limit=${limit}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${opts.appKey}` } },
      ),
      `Customer.io ESP ${opts.type}`,
    );
    const batch = page.suppressions ?? [];
    emails.push(...batch.map((s) => s.email));
    if (batch.length < limit) break;
  }

  return emails;
}
