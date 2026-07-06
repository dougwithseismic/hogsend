import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import {
  cioBaseUrl,
  fetchCioEspSuppressions,
  mapCioCsv,
  runCioExport,
} from "../lib/import-customerio.js";
import {
  checkLoopsSuppression,
  fetchLoopsCustomProperties,
  fetchLoopsLists,
  mapLoopsCsv,
} from "../lib/import-loops.js";
import type {
  ContactImportRow,
  ImportSummary,
  SuppressionImportRow,
} from "../lib/import-shared.js";
import {
  createRateLimitedFetch,
  mapGenericContactsCsv,
  mapGenericSuppressionsCsv,
  pollImportJobs,
  submitImportJobs,
} from "../lib/import-shared.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend import <subcommand> [options]

Migrate contacts AND their suppression state (unsubscribes, bounces, spam
complaints) into Hogsend from a CSV or another platform's API. Submits async
import jobs to /v1/admin/contacts/import and /v1/admin/suppressions/import
(one job per 5,000 rows), then polls each job to completion.

Subcommands:
  csv                   Import a generic header CSV.
  loops                 Import a Loops dashboard audience CSV (+ optional API
                        enrichment). Loops has NO bulk contacts API — download
                        the CSV from your Audience page first.
  customerio            Export people from the Customer.io App API and import
                        them (async export job + download).

csv options:
  --file <path>         The CSV to import (required). Header row expected.
                        email / externalId columns map to identity; every
                        other column becomes a contact property.
  --suppressions        Treat the file as a suppression list instead:
                        columns email (required), reason (unsubscribed |
                        bounced | complained, default unsubscribed),
                        externalId (optional).

loops options:
  --csv <path>          The audience CSV from the Loops dashboard (required).
                        userId maps to externalId; names + custom columns map
                        to properties; rows with subscribed=false also become
                        suppression rows (reason unsubscribed).
  --api-key <key>       Loops API key. Fetches your custom property
                        definitions (GET /v1/contacts/properties) to type-
                        coerce number/boolean columns, and lists your mailing
                        lists for reference.
  --check-suppressions  Also query GET /v1/contacts/suppression for EVERY
                        contact (requires --api-key). Loops merges bounces and
                        spam complaints into one suppression flag, so a
                        suppressed contact imports with reason "bounced".
                        Slow on big lists: one request per contact at 10 req/s
                        (a time estimate is printed first).

customerio options:
  --app-key <key>       Customer.io App API key (Bearer; required).
  --region <us|eu>      API region (default us).
  --segment <id>        Export one segment instead of everyone.
  --esp-suppressions    Also import the ESP suppression list
                        (GET /v1/esp/suppression/bounces → reason bounced,
                        /spam_reports → reason complained). Only available
                        when Customer.io delivers your email; skipped with a
                        warning otherwise.

Global options (handled by the router): --url, --admin-key, --json, -h/--help.

Examples:
  hogsend import csv --file contacts.csv
  hogsend import csv --file unsubscribes.csv --suppressions
  hogsend import loops --csv audience.csv
  hogsend import loops --csv audience.csv --api-key $LOOPS_API_KEY --check-suppressions
  hogsend import customerio --app-key $CIO_APP_KEY --region eu
  hogsend import customerio --app-key $CIO_APP_KEY --esp-suppressions`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} import`;

const CONTACTS_ENDPOINT = "/v1/admin/contacts/import";
const SUPPRESSIONS_ENDPOINT = "/v1/admin/suppressions/import";

/**
 * Submit + poll the contact rows and suppression rows as import jobs, then
 * print (or emit as JSON) the overall summary.
 */
async function runImportPipeline(
  ctx: CommandContext,
  opts: {
    contacts: ContactImportRow[];
    suppressions: SuppressionImportRow[];
    fileName: string;
  },
): Promise<void> {
  const { contacts, suppressions, fileName } = opts;

  if (contacts.length === 0 && suppressions.length === 0) {
    ctx.out.fail("nothing to import — no contact or suppression rows found");
  }

  const summaries: Record<string, ImportSummary> = {};

  try {
    if (contacts.length > 0) {
      ctx.out.log(`Importing ${contacts.length} contact(s)...`);
      const jobIds = await submitImportJobs({
        http: ctx.http,
        out: ctx.out,
        endpoint: CONTACTS_ENDPOINT,
        rows: contacts,
        fileName,
      });
      summaries.contacts = await pollImportJobs({
        http: ctx.http,
        out: ctx.out,
        endpoint: CONTACTS_ENDPOINT,
        jobIds,
      });
    }

    if (suppressions.length > 0) {
      ctx.out.log(`Importing ${suppressions.length} suppression(s)...`);
      const jobIds = await submitImportJobs({
        http: ctx.http,
        out: ctx.out,
        endpoint: SUPPRESSIONS_ENDPOINT,
        rows: suppressions,
        fileName,
      });
      summaries.suppressions = await pollImportJobs({
        http: ctx.http,
        out: ctx.out,
        endpoint: SUPPRESSIONS_ENDPOINT,
        jobIds,
      });
    }
  } catch (err) {
    if (isHttpError(err)) ctx.out.fail(err.message);
    throw err;
  }

  if (ctx.json) {
    ctx.out.json(summaries);
    return;
  }

  for (const [kind, s] of Object.entries(summaries)) {
    ctx.out.kv(
      {
        jobs: s.jobs,
        totalRows: s.totalRows,
        processedRows: s.processedRows,
        failedRows: s.failedRows,
        ...(s.errors.length > 0
          ? {
              firstErrors: s.errors
                .slice(0, 5)
                .map((e) => `row ${e.row}: ${e.error}`),
            }
          : {}),
      },
      kind,
    );
  }

  const failed = Object.values(summaries).reduce((n, s) => n + s.failedRows, 0);
  ctx.out.outro(
    failed > 0
      ? `Import finished with ${failed} failed row(s) — see errors above.`
      : "Import finished.",
  );
}

async function readFileOrFail(
  ctx: CommandContext,
  path: string,
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    ctx.out.fail(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runCsv(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: "string" },
      suppressions: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }
  if (!values.file) {
    ctx.out.fail("import csv requires --file <path>");
  }

  if (!ctx.json) ctx.out.intro(`${badge} csv`);

  const csv = await readFileOrFail(ctx, values.file);
  const fileName = values.file.split("/").pop() ?? values.file;

  let contacts: ContactImportRow[] = [];
  let suppressions: SuppressionImportRow[] = [];
  try {
    if (values.suppressions) {
      suppressions = mapGenericSuppressionsCsv(csv);
    } else {
      contacts = mapGenericContactsCsv(csv);
    }
  } catch (err) {
    ctx.out.fail(err instanceof Error ? err.message : String(err));
  }

  await runImportPipeline(ctx, { contacts, suppressions, fileName });
}

async function runLoops(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      csv: { type: "string" },
      "api-key": { type: "string" },
      "check-suppressions": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }
  if (!values.csv) {
    ctx.out.fail(
      "import loops requires --csv <audience.csv> — Loops has no bulk contacts API; download the CSV from your Audience page",
    );
  }
  const apiKey = values["api-key"];
  if (values["check-suppressions"] && !apiKey) {
    ctx.out.fail("--check-suppressions requires --api-key");
  }

  if (!ctx.json) ctx.out.intro(`${badge} loops`);

  const csv = await readFileOrFail(ctx, values.csv);
  const fileName = values.csv.split("/").pop() ?? values.csv;

  // Loops baseline: 10 requests/second per team, 429 + backoff on excess.
  const loopsFetch = createRateLimitedFetch({ minIntervalMs: 100 });

  let propTypes: Awaited<ReturnType<typeof fetchLoopsCustomProperties>> = [];
  if (apiKey) {
    try {
      propTypes = await ctx.out.step("Fetching custom property types", () =>
        fetchLoopsCustomProperties({ apiKey, fetch: loopsFetch }),
      );
      const lists = await ctx.out.step("Fetching mailing lists", () =>
        fetchLoopsLists({ apiKey, fetch: loopsFetch }),
      );
      if (lists.length > 0) {
        ctx.out.log(
          `Loops mailing lists (membership is not in the CSV export): ${lists
            .map((l) => `${l.name} (${l.id})`)
            .join(", ")}`,
        );
      }
    } catch (err) {
      ctx.out.log(
        `Warning: Loops API enrichment failed (${err instanceof Error ? err.message : String(err)}) — importing with string properties.`,
      );
    }
  }

  let mapped: ReturnType<typeof mapLoopsCsv>;
  try {
    mapped = mapLoopsCsv(csv, propTypes);
  } catch (err) {
    ctx.out.fail(err instanceof Error ? err.message : String(err));
  }
  const { contacts, suppressions } = mapped;

  if (values["check-suppressions"] && apiKey) {
    const emails = contacts
      .map((cnt) => cnt.email)
      .filter((e): e is string => Boolean(e));
    const estimateSec = Math.ceil(emails.length / 10);
    ctx.out.log(
      `Checking Loops suppression per contact: ${emails.length} request(s) at 10 req/s ≈ ${formatDuration(estimateSec)}.`,
    );
    let found = 0;
    for (const [i, email] of emails.entries()) {
      const suppressed = await checkLoopsSuppression({
        apiKey,
        email,
        fetch: loopsFetch,
      });
      if (suppressed) {
        found++;
        // Loops merges hard bounces + spam complaints into ONE suppression
        // flag with no way to tell them apart; map to "bounced" (both are
        // deliverability blocks; "complained" would claim knowledge we don't
        // have).
        suppressions.push({ email, reason: "bounced" });
      }
      if ((i + 1) % 500 === 0) {
        ctx.out.log(
          `Checked ${i + 1}/${emails.length} (${found} suppressed so far)`,
        );
      }
    }
    ctx.out.log(`Suppression check done: ${found} suppressed contact(s).`);
  }

  await runImportPipeline(ctx, { contacts, suppressions, fileName });
}

function formatDuration(totalSec: number): string {
  if (totalSec < 90) return `${totalSec}s`;
  const min = Math.round(totalSec / 60);
  return `${min} min`;
}

async function runCustomerio(
  ctx: CommandContext,
  argv: string[],
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "app-key": { type: "string" },
      region: { type: "string", default: "us" },
      segment: { type: "string" },
      "esp-suppressions": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }
  const appKey = values["app-key"];
  if (!appKey) {
    ctx.out.fail("import customerio requires --app-key <key> (App API key)");
  }
  if (values.region !== "us" && values.region !== "eu") {
    ctx.out.fail("--region must be us or eu");
  }
  let segmentId: number | undefined;
  if (values.segment !== undefined) {
    segmentId = Number(values.segment);
    if (!Number.isInteger(segmentId)) {
      ctx.out.fail("--segment must be a numeric segment id");
    }
  }

  if (!ctx.json) ctx.out.intro(`${badge} customerio`);

  const baseUrl = cioBaseUrl(values.region);
  // App API: 10 requests/second, 429 on excess.
  const cioFetch = createRateLimitedFetch({ minIntervalMs: 100 });

  let csv: string;
  try {
    csv = await ctx.out.step(
      segmentId
        ? `Exporting segment ${segmentId} from Customer.io`
        : "Exporting all people from Customer.io",
      () =>
        runCioExport({
          appKey,
          baseUrl,
          segmentId,
          fetch: cioFetch,
        }),
    );
  } catch (err) {
    ctx.out.fail(err instanceof Error ? err.message : String(err));
  }

  let mapped: ReturnType<typeof mapCioCsv>;
  try {
    mapped = mapCioCsv(csv);
  } catch (err) {
    ctx.out.fail(err instanceof Error ? err.message : String(err));
  }
  const { contacts, suppressions } = mapped;

  if (values["esp-suppressions"]) {
    for (const [type, reason] of [
      ["bounces", "bounced"],
      ["spam_reports", "complained"],
    ] as const) {
      try {
        const emails = await ctx.out.step(
          `Fetching ESP suppression list (${type})`,
          () =>
            fetchCioEspSuppressions({
              appKey,
              baseUrl,
              type,
              fetch: cioFetch,
            }),
        );
        for (const email of emails) {
          suppressions.push({ email: email.toLowerCase(), reason });
        }
      } catch (err) {
        // Only available when Customer.io's ESP delivers the email — a
        // custom-SMTP workspace errors here. Warn and continue.
        ctx.out.log(
          `Warning: could not fetch ESP ${type} (${err instanceof Error ? err.message : String(err)}) — skipping. This list only exists when Customer.io's ESP sends your email.`,
        );
      }
    }
  }

  await runImportPipeline(ctx, {
    contacts,
    suppressions,
    fileName: segmentId
      ? `customerio segment ${segmentId}`
      : "customerio export",
  });
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "csv":
      return runCsv(ctx, ctx.argv.slice(1));
    case "loops":
      return runLoops(ctx, ctx.argv.slice(1));
    case "customerio":
      return runCustomerio(ctx, ctx.argv.slice(1));
    case undefined:
      ctx.out.fail(
        "import requires a subcommand: csv, loops, or customerio (see hogsend import --help)",
      );
      break;
    default:
      ctx.out.fail(
        `unknown import subcommand "${sub}" — expected csv, loops, or customerio`,
      );
  }
}

export const importCommand: Command = {
  name: "import",
  summary:
    "Migrate contacts + suppression lists from a CSV, Loops, or Customer.io",
  usage,
  run,
};
