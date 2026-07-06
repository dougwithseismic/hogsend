import Papa from "papaparse";
import type { AdminClient } from "./http.js";
import type { Output } from "./output.js";

/** Reasons accepted by POST /v1/admin/suppressions/import. */
export type SuppressionReason = "unsubscribed" | "bounced" | "complained";

/** One row for POST /v1/admin/contacts/import (JSON format). */
export interface ContactImportRow {
  externalId?: string;
  email?: string;
  properties?: Record<string, unknown>;
}

/** One row for POST /v1/admin/suppressions/import (JSON format). */
export interface SuppressionImportRow {
  email: string;
  reason: SuppressionReason;
  externalId?: string;
}

/** Rows per import job. Large inputs become one job per chunk. */
export const CHUNK_SIZE = 5000;

export function chunk<T>(rows: T[], size: number = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

/** Parse a header-mode CSV into string records. Throws on a headerless file. */
export function parseCsvRecords(csv: string): {
  fields: string[];
  records: Record<string, string>[];
} {
  const result = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  const fields = result.meta.fields ?? [];
  if (fields.length === 0) {
    throw new Error("CSV has no header row");
  }
  return { fields, records: result.data };
}

/**
 * Generic contacts CSV → import rows: `email` / `externalId` columns are the
 * identity keys, every other column becomes a (string) property. Empty cells
 * are dropped.
 */
export function mapGenericContactsCsv(csv: string): ContactImportRow[] {
  const { fields, records } = parseCsvRecords(csv);
  if (!fields.includes("email") && !fields.includes("externalId")) {
    throw new Error("CSV must have an email or externalId column");
  }
  return records.map((record) => {
    const { email, externalId, ...rest } = record;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== "") properties[key] = value;
    }
    return {
      externalId: externalId || undefined,
      email: email || undefined,
      properties: Object.keys(properties).length > 0 ? properties : undefined,
    };
  });
}

/**
 * Generic suppressions CSV → import rows: columns `email` (required),
 * `reason` (optional, defaults server-side to `unsubscribed`), `externalId`
 * (optional). Other columns are ignored.
 */
export function mapGenericSuppressionsCsv(csv: string): SuppressionImportRow[] {
  const { fields, records } = parseCsvRecords(csv);
  if (!fields.includes("email")) {
    throw new Error("Suppressions CSV must have an email column");
  }
  return records
    .filter((record) => record.email)
    .map((record) => ({
      email: record.email as string,
      reason: (record.reason || "unsubscribed") as SuppressionReason,
      ...(record.externalId ? { externalId: record.externalId } : {}),
    }));
}

// ---------------------------------------------------------------------------
// Rate-limited fetch (source-platform APIs: 10 req/s, retry on 429)
// ---------------------------------------------------------------------------

export interface RateLimitedFetchOptions {
  /** Minimum gap between request starts. 100ms = 10 req/s. */
  minIntervalMs?: number;
  /** Max retries on 429 before giving up. */
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A fetch wrapper that (a) spaces request starts `minIntervalMs` apart and
 * (b) retries 429 responses with exponential backoff (honouring Retry-After
 * when the server sends one). Non-429 responses are returned as-is — callers
 * still check `res.ok`.
 */
export function createRateLimitedFetch(
  opts: RateLimitedFetchOptions = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const minInterval = opts.minIntervalMs ?? 100;
  const maxRetries = opts.maxRetries ?? 5;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let nextSlot = 0;

  const takeSlot = async () => {
    const now = Date.now();
    const wait = nextSlot - now;
    nextSlot = Math.max(nextSlot, now) + minInterval;
    if (wait > 0) await sleep(wait);
  };

  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      await takeSlot();
      const res = await fetchImpl(url, init);
      if (res.status !== 429 || attempt >= maxRetries) {
        return res;
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 30_000);
      await sleep(backoff);
    }
  };
}

// ---------------------------------------------------------------------------
// Import-job submission + polling (Hogsend admin API)
// ---------------------------------------------------------------------------

export interface ImportJobStatus {
  id: string;
  status: string;
  totalRows: number | null;
  processedRows: number;
  failedRows: number;
  errors: Array<{ row: number; error: string }> | null;
}

export interface ImportSummary {
  jobs: number;
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errors: Array<{ row: number; error: string }>;
}

/**
 * Split `rows` into chunks of {@link CHUNK_SIZE} and POST one JSON import job
 * per chunk to `endpoint` (`/v1/admin/contacts/import` or
 * `/v1/admin/suppressions/import`). Returns the created job ids.
 */
export async function submitImportJobs(opts: {
  http: AdminClient;
  out: Output;
  endpoint: string;
  rows: unknown[];
  fileName: string;
}): Promise<string[]> {
  const { http, out, endpoint, rows, fileName } = opts;
  const chunks = chunk(rows);
  const jobIds: string[] = [];

  for (const [i, part] of chunks.entries()) {
    const res = await out.step(
      `Submitting job ${i + 1}/${chunks.length} (${part.length} rows)`,
      () =>
        http.post<{ jobId: string; status: string }>(endpoint, {
          format: "json",
          data: JSON.stringify(part),
          fileName:
            chunks.length > 1 ? `${fileName} (part ${i + 1})` : fileName,
        }),
    );
    jobIds.push(res.jobId);
  }

  return jobIds;
}

/**
 * Poll each job's status route until it reaches `completed` or `failed`,
 * logging a progress line per poll. Returns the aggregated summary (totals,
 * failed-row count, first errors).
 */
export async function pollImportJobs(opts: {
  http: AdminClient;
  out: Output;
  endpoint: string;
  jobIds: string[];
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ImportSummary> {
  const { http, out, endpoint, jobIds } = opts;
  const interval = opts.pollIntervalMs ?? 1500;
  const sleep = opts.sleep ?? defaultSleep;

  const summary: ImportSummary = {
    jobs: jobIds.length,
    totalRows: 0,
    processedRows: 0,
    failedRows: 0,
    errors: [],
  };

  for (const [i, jobId] of jobIds.entries()) {
    let job: ImportJobStatus;
    for (;;) {
      job = await http.get<ImportJobStatus>(`${endpoint}/${jobId}`);
      if (job.status === "completed" || job.status === "failed") break;
      out.log(
        `Job ${i + 1}/${jobIds.length} ${job.status}: ${job.processedRows}/${job.totalRows ?? "?"} rows (${job.failedRows} failed)`,
      );
      await sleep(interval);
    }
    out.log(
      `Job ${i + 1}/${jobIds.length} ${job.status}: ${job.processedRows} processed, ${job.failedRows} failed`,
    );
    summary.totalRows += job.totalRows ?? 0;
    summary.processedRows += job.processedRows;
    summary.failedRows += job.failedRows;
    if (job.errors) summary.errors.push(...job.errors);
  }

  summary.errors = summary.errors.slice(0, 20);
  return summary;
}
