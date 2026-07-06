import type {
  ContactImportRow,
  SuppressionImportRow,
} from "./import-shared.js";
import { parseCsvRecords } from "./import-shared.js";

export const LOOPS_API_BASE = "https://app.loops.so/api";

/** One entry from GET /v1/contacts/properties. */
export interface LoopsProperty {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "date";
}

/** One entry from GET /v1/lists. */
export interface LoopsList {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
}

/**
 * Columns of the Loops dashboard audience CSV that are identity/subscription
 * state, not contact properties. Everything else (built-ins like firstName +
 * custom properties) maps into `properties`.
 */
const LOOPS_NON_PROPERTY_COLUMNS = new Set(["email", "userId", "subscribed"]);

/**
 * Coerce a CSV cell to the type Loops declares for the property. Dates stay
 * strings (Hogsend contact properties are JSON; an ISO string round-trips).
 * Unparseable values fall back to the raw string rather than dropping data.
 */
export function coerceLoopsValue(
  raw: string,
  type?: LoopsProperty["type"],
): unknown {
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
  }
  if (type === "boolean") {
    const v = raw.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    return raw;
  }
  return raw;
}

/** "false"/"FALSE" (and "0") count as unsubscribed in the dashboard CSV. */
function isFalseFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "false" || v === "0";
}

/**
 * Map the Loops dashboard audience CSV (the ONLY bulk export Loops offers —
 * there is no list-contacts API endpoint) to Hogsend import rows:
 *
 * - `userId` → `externalId`, `email` → `email`
 * - every other column (firstName, lastName, source, userGroup, custom
 *   properties, ...) → `properties`, type-coerced when `propTypes` (from
 *   GET /v1/contacts/properties) is provided
 * - `subscribed = false` additionally yields a suppression row with reason
 *   `unsubscribed` (Loops semantics: opted out of campaign/workflow emails)
 */
export function mapLoopsCsv(
  csv: string,
  propTypes?: LoopsProperty[],
): { contacts: ContactImportRow[]; suppressions: SuppressionImportRow[] } {
  const { fields, records } = parseCsvRecords(csv);
  if (!fields.includes("email")) {
    throw new Error(
      "Loops audience CSV must have an email column — export it from the Audience page",
    );
  }

  const typeByKey = new Map(propTypes?.map((p) => [p.key, p.type]) ?? []);

  const contacts: ContactImportRow[] = [];
  const suppressions: SuppressionImportRow[] = [];

  for (const record of records) {
    const email = record.email?.trim().toLowerCase();
    if (!email) continue;
    const externalId = record.userId?.trim() || undefined;

    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (LOOPS_NON_PROPERTY_COLUMNS.has(key) || value === "") continue;
      properties[key] = coerceLoopsValue(value, typeByKey.get(key));
    }

    contacts.push({
      email,
      ...(externalId ? { externalId } : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
    });

    if (isFalseFlag(record.subscribed)) {
      suppressions.push({
        email,
        reason: "unsubscribed",
        ...(externalId ? { externalId } : {}),
      });
    }
  }

  return { contacts, suppressions };
}

/** GET /v1/contacts/properties?list=custom — the custom property definitions. */
export async function fetchLoopsCustomProperties(opts: {
  apiKey: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<LoopsProperty[]> {
  const res = await opts.fetch(
    `${LOOPS_API_BASE}/v1/contacts/properties?list=custom`,
    { headers: { Authorization: `Bearer ${opts.apiKey}` } },
  );
  if (!res.ok) {
    throw new Error(`Loops properties request failed (${res.status})`);
  }
  return (await res.json()) as LoopsProperty[];
}

/** GET /v1/lists — mailing list metadata (informational). */
export async function fetchLoopsLists(opts: {
  apiKey: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<LoopsList[]> {
  const res = await opts.fetch(`${LOOPS_API_BASE}/v1/lists`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Loops lists request failed (${res.status})`);
  }
  return (await res.json()) as LoopsList[];
}

/**
 * GET /v1/contacts/suppression?email=... — Loops has NO bulk suppression
 * export; this is a per-contact lookup (one request per contact, 10 req/s).
 * Loops' suppression list merges hard bounces AND spam complaints into one
 * flag, so a `true` here maps to Hogsend reason `bounced` (the conservative
 * deliverability-block reading; there is no way to tell the two apart).
 */
export async function checkLoopsSuppression(opts: {
  apiKey: string;
  email: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<boolean> {
  const res = await opts.fetch(
    `${LOOPS_API_BASE}/v1/contacts/suppression?email=${encodeURIComponent(opts.email)}`,
    { headers: { Authorization: `Bearer ${opts.apiKey}` } },
  );
  if (res.status === 404) {
    // Contact unknown to Loops — genuinely not suppressed.
    return false;
  }
  if (!res.ok) {
    // Anything else (401/403 bad key, a 429 that survived the retries, 5xx)
    // must ABORT, not read as "not suppressed": silently returning false here
    // would let a whole --check-suppressions run complete with zero
    // suppressions imported while reporting success.
    const hint =
      res.status === 401 || res.status === 403
        ? " — check your Loops API key"
        : "";
    throw new Error(`Loops suppression check failed (${res.status})${hint}`);
  }
  const body = (await res.json()) as { isSuppressed?: boolean };
  return body.isSuppressed === true;
}
