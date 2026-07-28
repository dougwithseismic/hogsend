import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { importJobStatusEnum } from "./enums.js";

/**
 * Resumable-pull state for a long-running import job — the bag a rate-limited
 * or interrupted pull continues from on the next tick instead of restarting.
 * Deliberately a `jsonb` bag of optional keys: a new consumer widens this type
 * without a migration.
 */
export type ImportJobMetadata = {
  /** Provider-defined page cursor (a next-page URL, an offset, a token). */
  cursor?: string | null;
  /** The bound PostHog cohort id this job is pulling. */
  cohortId?: number | string | null;
  /** PostHog's `last_calculation` watermark at the last successful observation. */
  lastCalculation?: string | null;
  /** Consecutive failed observations — a run of them degrades the binding. */
  consecutiveFailures?: number;
  /** Set when observation keeps failing; no transitions are emitted while true. */
  degraded?: boolean;
};

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fileName: text("file_name"),
    format: text("format").notNull(),
    status: importJobStatusEnum("status").notNull().default("pending"),
    totalRows: integer("total_rows"),
    processedRows: integer("processed_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    errors: jsonb("errors").$type<Array<{ row: number; error: string }>>(),
    /** {@link ImportJobMetadata} — resumable cursor + observation watermarks. */
    metadata: jsonb("metadata").$type<ImportJobMetadata>(),
    ...timestamps,
  },
  (table) => [index("import_jobs_status_idx").on(table.status)],
);
