import type { Database } from "@hogsend/db";
import { sql } from "drizzle-orm";
import { globalControlPercent, isGlobalControl } from "./holdout.js";
import { computeLift, type LiftVerdict } from "./lift-stats.js";

/**
 * Program-level global-control readout (impact-experiments spec D4.5e).
 * Assignment lives only in env + hash (no assignment table), so the
 * readout recomputes membership per contact as
 * key = externalId ?? anonymousId ?? id, which is what
 * isGlobalControl(options.userId ?? options.to) hashes at send time
 * (lib/tracked.ts:245-246, lib/sms-tracked.ts:225-226) for JOURNEY sends —
 * a journey's `userId` is the ingest-resolved key
 * (event.userId ?? event.anonymousId, lib/ingestion.ts), so an
 * anonymous-triggered journey hashes the same anonymousId the readout
 * falls back to.
 *
 * DISCLOSED APPROXIMATION: two OTHER send paths resolve a different key and
 * can disagree with the readout for a contact whose external_id is NULL but
 * anonymous_id is set (the readout hashes anonymous_id; these paths hash the
 * contact's UUID instead, never anonymous_id):
 *   - bare POST /v1/emails — regardless of whether the caller supplied a
 *     userId, the route always resolves the send's userId as
 *     recipient.externalId ?? recipient.contactId (routes/emails/index.ts),
 *     so it can never fall through to anonymous_id.
 *   - list-audience campaign broadcasts — the send-campaign cursor query
 *     resolves the same externalId ?? contactId fallback
 *     (workflows/send-campaign.ts), also never anonymous_id.
 * Journey sends stay in parity with the readout (see above); the
 * divergence is bounded to these two paths, so the fallback chain remains
 * a reasonable, disclosed approximation for a mixed-population program —
 * not a blanket "no userId" case.
 *
 * Converter outcomes aggregate ALL definitions (global control suppresses
 * all non-transactional sends, so any registered conversion is a fair
 * program-level outcome; no definitionId knob in v1). ITT caveat: this is
 * a cross-sectional randomized comparison — outcome window
 * occurred_at >= since for BOTH buckets; random assignment keeps it
 * causal, window symmetry keeps it fair.
 */

/** In-request scan ceiling — above this the readout reports `skipped`
 * (honest ceiling; a cached cron materialization is explicitly deferred). */
export const GLOBAL_CONTROL_SCAN_CEILING = 500_000;

const DEFAULT_BATCH_SIZE = 5_000;

type ContactPageRow = {
  id: string;
  external_id: string | null;
  anonymous_id: string | null;
};

/**
 * Fetches one keyset-paginated page of live contacts. Extracted to a
 * top-level function (rather than inlined in the pagination loop) with an
 * explicit return type — TS's control-flow narrowing of `cursor` across
 * loop iterations otherwise creates a self-referential inference cycle
 * (`pageQuery` → `page` → `rows` → next-iteration `cursor` → `pageQuery`)
 * that surfaces as a spurious implicit-any (TS7022) when inlined.
 */
async function fetchContactPage(
  db: Database,
  cursor: string | null,
  batchSize: number,
): Promise<ContactPageRow[]> {
  const pageQuery =
    cursor === null
      ? sql`select id, external_id, anonymous_id from contacts
            where deleted_at is null
            order by id asc limit ${batchSize}`
      : sql`select id, external_id, anonymous_id from contacts
            where deleted_at is null and id > ${cursor}::uuid
            order by id asc limit ${batchSize}`;
  const page = await db.execute<ContactPageRow>(pageQuery);
  return [...page];
}

export type GlobalControlReadout =
  | { state: "off" }
  | {
      state: "skipped";
      reason: "too_many_contacts";
      percent: number;
      contactCount: number;
    }
  | ({
      state: "computed";
      causal: true;
      percent: number;
      contactsScanned: number;
      treatment: { contacts: number; converters: number; rate: number };
      control: { contacts: number; converters: number; rate: number };
    } & LiftVerdict);

export async function computeGlobalControlReadout(opts: {
  db: Database;
  since: Date;
  /** Scan ceiling override — the route always uses the default; the
   * parameter exists so the skipped state is testable. */
  scanCeiling?: number;
  batchSize?: number;
}): Promise<GlobalControlReadout> {
  const percent = globalControlPercent();
  if (percent === 0) return { state: "off" };

  const ceiling = opts.scanCeiling ?? GLOBAL_CONTROL_SCAN_CEILING;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const sinceTs = sql`${opts.since.toISOString()}::timestamptz`;

  const countRows = await opts.db.execute<{ count: number }>(
    sql`select count(*)::int as count
        from contacts where deleted_at is null`,
  );
  const contactCount = Number([...countRows][0]?.count ?? 0);
  if (contactCount > ceiling) {
    return {
      state: "skipped",
      reason: "too_many_contacts",
      percent,
      contactCount,
    };
  }

  const converterRows = await opts.db.execute<{ contact_id: string }>(
    sql`select distinct contact_id from conversions
        where occurred_at >= ${sinceTs}`,
  );
  const converterSet = new Set([...converterRows].map((r) => r.contact_id));

  let cursor: string | null = null;
  let scanned = 0;
  const treatment = { contacts: 0, converters: 0 };
  const control = { contacts: 0, converters: 0 };
  while (true) {
    const rows = await fetchContactPage(opts.db, cursor, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = row.external_id ?? row.anonymous_id ?? row.id;
      const bucket = isGlobalControl(key) ? control : treatment;
      bucket.contacts += 1;
      if (converterSet.has(row.id)) bucket.converters += 1;
    }
    scanned += rows.length;
    cursor = rows[rows.length - 1]?.id ?? null;
    if (rows.length < batchSize) break;
  }

  const verdict = computeLift({ treatment, control });
  return {
    state: "computed",
    causal: true,
    percent,
    contactsScanned: scanned,
    treatment: {
      ...treatment,
      rate:
        treatment.contacts > 0 ? treatment.converters / treatment.contacts : 0,
    },
    control: {
      ...control,
      rate: control.contacts > 0 ? control.converters / control.contacts : 0,
    },
    ...verdict,
  };
}
