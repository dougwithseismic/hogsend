import { createDatabase, importJobs } from "@hogsend/db";
import { eq } from "drizzle-orm";
import Papa from "papaparse";
import { upsertContact } from "../lib/contacts.js";
import { hatchet } from "../lib/hatchet.js";

const BATCH_SIZE = 500;

export const importContactsTask = hatchet.task({
  name: "import-contacts",
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

    let rows: Array<{
      externalId: string;
      email?: string;
      properties?: Record<string, unknown>;
    }>;

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
        batch.map((row, idx) =>
          upsertContact({
            db,
            externalId: row.externalId,
            email: row.email,
            properties: row.properties,
          }).then(() => ({ index: i + idx, ok: true })),
        ),
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

function parseCsv(data: string): Array<{
  externalId: string;
  email?: string;
  properties?: Record<string, unknown>;
}> {
  const result = Papa.parse<Record<string, string>>(data, {
    header: true,
    skipEmptyLines: true,
  });

  if (!result.meta.fields?.includes("externalId")) {
    throw new Error("CSV must have an externalId column");
  }

  return result.data.map((row) => {
    const { externalId, email, ...rest } = row;
    const properties = Object.keys(rest).length > 0 ? rest : undefined;
    return {
      externalId: externalId ?? "",
      email: email || undefined,
      properties: properties as Record<string, unknown> | undefined,
    };
  });
}
