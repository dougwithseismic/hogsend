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
    ...timestamps,
  },
  (table) => [index("import_jobs_status_idx").on(table.status)],
);
