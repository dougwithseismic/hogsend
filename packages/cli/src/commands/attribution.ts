import { parseArgs } from "node:util";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend attribution backfill [options]

Replay historical events through conversion evaluation + the attribution
credit ledger. An existing deploy that upgrades gets its whole history
credited; a definition/window change gets a clean, logged recompute. Both
machines are idempotent — re-running a backfill never double-counts.

Loops POST /v1/admin/attribution/backfill until the cursor is exhausted,
printing per-batch progress. Ad-platform dispatches are never re-fired
for historical conversions.

Options:
  --definition <id>    Only this conversion definition (default: all).
  --since <iso>        Only events/conversions at or after this instant.
  --recompute          Delete-then-refill the definition's credits under the
                       CURRENT window config. Requires --definition.
  --limit <n>          Batch size, 1-2000 (default 500).
  --url <baseUrl>      API base URL (default HOGSEND_API_URL or http://localhost:3002).
  --admin-key <key>    Admin bearer key (default HOGSEND_ADMIN_KEY / ADMIN_API_KEY).
  --json               Emit machine-readable JSON only.
  -h, --help           Show this help.`;

interface BackfillBatch {
  stage: "events" | "credits";
  processed: number;
  conversionsFired: number;
  creditsWritten: number;
  nextCursor: string | null;
}

async function run(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      definition: { type: "string" },
      since: { type: "string" },
      recompute: { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });

  if (values.help || positionals[0] !== "backfill") {
    ctx.out.log(usage);
    return;
  }
  if (values.recompute && !values.definition) {
    throw new Error("--recompute requires --definition (never blanket)");
  }

  const limit = values.limit ? Number(values.limit) : 500;
  let cursor: string | undefined;
  let batches = 0;
  const totals = { processed: 0, conversionsFired: 0, creditsWritten: 0 };

  await ctx.out.step("Backfilling attribution", async () => {
    do {
      const batch = await ctx.http.post<BackfillBatch>(
        "/v1/admin/attribution/backfill",
        {
          definitionId: values.definition,
          since: values.since,
          cursor,
          limit,
          // Recompute applies to the FIRST call only (no cursor yet) — the
          // server deletes once, then every loop iteration just refills.
          recompute: values.recompute && !cursor,
        },
      );
      batches++;
      totals.processed += batch.processed;
      totals.conversionsFired += batch.conversionsFired;
      totals.creditsWritten += batch.creditsWritten;
      cursor = batch.nextCursor ?? undefined;
      if (!ctx.json && batches % 10 === 0) {
        ctx.out.log(
          `  …${totals.processed} rows scanned, ${totals.conversionsFired} conversions, ${totals.creditsWritten} credited`,
        );
      }
    } while (cursor);
  });

  if (ctx.json) {
    ctx.out.json({ batches, ...totals });
    return;
  }
  ctx.out.log(
    `Backfill complete: ${totals.processed} rows scanned across ${batches} batch${batches === 1 ? "" : "es"}, ` +
      `${totals.conversionsFired} conversions fired, ${totals.creditsWritten} newly credited.`,
  );
}

export const attributionCommand: Command = {
  name: "attribution",
  summary: "Backfill attribution credits from event history",
  usage,
  run,
};
