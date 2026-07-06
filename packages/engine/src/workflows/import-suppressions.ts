import { createDatabase, importJobs } from "@hogsend/db";
import { eq } from "drizzle-orm";
import Papa from "papaparse";
import { resolveRecipient } from "../lib/contacts.js";
import { hatchet } from "../lib/hatchet.js";
import { upsertEmailPreference } from "../lib/preferences.js";

const BATCH_SIZE = 500;

export const SUPPRESSION_REASONS = [
  "unsubscribed",
  "bounced",
  "complained",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** One raw input row (a parsed CSV record or a JSON array element). */
export interface SuppressionImportRow {
  email?: string;
  reason?: string;
  externalId?: string;
}

/**
 * The `email_preferences` update a validated row maps to. Timestamp columns
 * are expressed as flags so the mapping stays pure (the task applies `now`):
 * `recordBounce` = `bounce_count = GREATEST(bounce_count, 1)` + `last_bounce_at`,
 * `setSuppressedAt` = `suppressed_at = now`.
 */
export interface MappedSuppressionRow {
  email: string;
  externalId?: string;
  reason: SuppressionReason;
  update: {
    unsubscribedAll?: boolean;
    suppressed?: boolean;
    setSuppressedAt?: boolean;
    recordBounce?: boolean;
  };
}

// Deliberately loose: enough to reject rows that can't be an address at all
// (no `@`, no domain dot) without bouncing real-world addresses. The engine
// stores normalized-raw emails (see `normalizeEmail`), it does not verify them.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pure row → preference-update mapping for the suppression import. Validates
 * and lowercases `email`, defaults `reason` to `unsubscribed`, and maps each
 * reason onto the existing derived `email_preferences` semantics (NO schema
 * change — see `routes/admin/suppressions.ts` typeFilter):
 *
 * - `unsubscribed` → `unsubscribed_all = true`
 * - `bounced`      → `suppressed = true` + bounce slate (`bounce_count >= 1`)
 * - `complained`   → `suppressed = true` with `bounce_count` untouched, so the
 *                    derived "complained" view (suppressed AND bounceCount = 0)
 *                    still identifies it
 *
 * Throws on an invalid row (missing/malformed email, unknown reason); the task
 * records the error against the row index.
 */
export function mapSuppressionRow(
  row: SuppressionImportRow,
): MappedSuppressionRow {
  const email = row.email?.trim().toLowerCase();
  if (!email) {
    throw new Error("Row has no email");
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new Error(`Invalid email: ${email}`);
  }

  const reason = (row.reason?.trim().toLowerCase() ||
    "unsubscribed") as SuppressionReason;
  if (!SUPPRESSION_REASONS.includes(reason)) {
    throw new Error(
      `Invalid reason "${row.reason}" — expected one of: ${SUPPRESSION_REASONS.join(", ")}`,
    );
  }

  const externalId = row.externalId?.trim() || undefined;

  switch (reason) {
    case "unsubscribed":
      return { email, externalId, reason, update: { unsubscribedAll: true } };
    case "bounced":
      return {
        email,
        externalId,
        reason,
        update: { suppressed: true, setSuppressedAt: true, recordBounce: true },
      };
    case "complained":
      return {
        email,
        externalId,
        reason,
        update: { suppressed: true, setSuppressedAt: true },
      };
  }
}

export const importSuppressionsTask = hatchet.task({
  name: "import-suppressions",
  retries: 0,
  executionTimeout: "600s",
  fn: async (input: { jobId: string; data: string; format: string }) => {
    const { db } = createDatabase({
      url: process.env.DATABASE_URL ?? "",
    });

    await db
      .update(importJobs)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(importJobs.id, input.jobId));

    let rows: SuppressionImportRow[];

    try {
      if (input.format === "json") {
        rows = JSON.parse(input.data);
      } else {
        rows = parseCsv(input.data);
      }
    } catch (err) {
      await db
        .update(importJobs)
        .set({
          status: "failed",
          errors: [
            {
              row: 0,
              error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          updatedAt: new Date(),
        })
        .where(eq(importJobs.id, input.jobId));
      return { status: "failed" };
    }

    await db
      .update(importJobs)
      .set({ totalRows: rows.length, updatedAt: new Date() })
      .where(eq(importJobs.id, input.jobId));

    let processed = 0;
    let failed = 0;
    const errors: Array<{ row: number; error: string }> = [];

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((row) => applySuppressionRow(db, row)),
      );

      results.forEach((result, batchIdx) => {
        if (result.status === "fulfilled") {
          processed++;
        } else {
          failed++;
          errors.push({
            row: i + batchIdx,
            error: result.reason?.message ?? "Unknown error",
          });
        }
      });

      await db
        .update(importJobs)
        .set({
          processedRows: processed,
          failedRows: failed,
          updatedAt: new Date(),
        })
        .where(eq(importJobs.id, input.jobId));
    }

    await db
      .update(importJobs)
      .set({
        status: failed === rows.length ? "failed" : "completed",
        processedRows: processed,
        failedRows: failed,
        errors: errors.length > 0 ? errors.slice(0, 100) : null,
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, input.jobId));

    return { status: "completed", processed, failed };
  },
});

type Db = ReturnType<typeof createDatabase>["db"];

/**
 * Map one row and write it through the single preference choke point.
 *
 * `user_id` resolution follows the existing convention (lib/preferences.ts):
 * resolve the contact by email — its `external_id` when present, else the
 * contact uuid. When NO contact exists the row is still written
 * (`checkSuppression` keys on email alone at send time) using the row's
 * `externalId` if given, else the email itself — the same synthesized fallback
 * `resolveRecipient` uses for a never-seen address.
 *
 * `emitOutbound: false` — a historical import must not fan out per-row
 * `contact.unsubscribed` events.
 */
async function applySuppressionRow(
  db: Db,
  row: SuppressionImportRow,
): Promise<void> {
  const mapped = mapSuppressionRow(row);

  const recipient = await resolveRecipient({ db, email: mapped.email });
  // resolveRecipient with an email arg always returns (synthesizing
  // `contactId: email` when no contact exists); the null-check keeps types
  // honest.
  const hasContact = recipient !== null && recipient.contactId !== mapped.email;
  const userId = hasContact
    ? (recipient.externalId ?? recipient.contactId)
    : (mapped.externalId ?? mapped.email);

  const { setSuppressedAt, recordBounce, ...update } = mapped.update;

  await upsertEmailPreference({
    db,
    externalId: userId,
    email: mapped.email,
    update: {
      ...update,
      ...(setSuppressedAt ? { suppressedAt: new Date() } : {}),
      ...(recordBounce ? { recordBounce: true } : {}),
    },
    emitOutbound: false,
  });
}

function parseCsv(data: string): SuppressionImportRow[] {
  const result = Papa.parse<Record<string, string>>(data, {
    header: true,
    skipEmptyLines: true,
  });

  const fields = result.meta.fields ?? [];
  if (!fields.includes("email")) {
    throw new Error("CSV must have an email column");
  }

  return result.data.map((row) => ({
    email: row.email || undefined,
    reason: row.reason || undefined,
    externalId: row.externalId || undefined,
  }));
}
