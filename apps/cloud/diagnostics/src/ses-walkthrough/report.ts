import type { SesRegion } from "../../../src/ses/types";
import type { SubstrateRegion } from "../../../src/substrate/types";
import type { CleanupReport } from "./cleanup";
import type { Divergence, RecordedStep } from "./divergence";
import type { WalkthroughNames } from "./naming";
import type { WalkthroughDkim } from "./walkthrough";

/**
 * Rendering only. Every decision the report describes was made elsewhere; this
 * turns it into something a human reads at 2am and a `--json` blob a follow-up
 * PRD can diff two runs of.
 *
 * The ONE rule with teeth: nothing here may print a secret. The DKIM private
 * key crosses the wire in `createIdentity`, the seam keeps AWS's response body
 * verbatim (correctly — a failure has to be diagnosable), and a rejection could
 * therefore quote the key back at us. {@link scrub} is the last line of
 * defence, applied to the whole rendered string rather than to the fields we
 * remembered to redact.
 */

/**
 * Everything one run produced. Lives HERE rather than next to the runner so
 * the renderer and the runner do not import each other.
 */
export interface WalkthroughReport {
  runId: string;
  region: SubstrateRegion;
  awsRegion: SesRegion;
  clientId: string;
  names: WalkthroughNames;
  /** Tenants from an EARLIER walkthrough run. Reported, never touched. */
  leftoverTenants: string[];
  steps: RecordedStep[];
  divergences: Divergence[];
  cleanup: CleanupReport;
  dkim: WalkthroughDkim;
  notes: string[];
  aborted?: string;
}

export function renderReport(report: WalkthroughReport): string {
  const lines: string[] = [];
  const say = (line = "") => lines.push(line);

  say("═".repeat(72));
  say(`SES contract walkthrough — run ${report.runId}`);
  say("═".repeat(72));
  say(
    `client=${report.clientId} region=${report.region} aws_region=${report.awsRegion}`,
  );
  say(`tenant=${report.names.tenantName}`);
  say(`configuration-set=${report.names.configurationSetName}`);
  say(`identity=${report.names.identityDomain}`);
  if (report.leftoverTenants.length > 0) {
    say("");
    say(
      `⚠ ${report.leftoverTenants.length} tenant(s) from an EARLIER walkthrough run are still in this account:`,
    );
    for (const name of report.leftoverTenants) say(`    ${name}`);
    say("  They are sweepable by name; this run did not touch them.");
  }

  say("");
  say("── verbs ─────────────────────────────────────────────────────────────");
  for (const step of report.steps) {
    if (step.status === "skipped") {
      say(`  ○ ${step.label}  SKIPPED — ${step.skipReason ?? "no reason"}`);
      continue;
    }
    const mark = step.divergences.length === 0 ? "✓" : "✗";
    const outcome =
      step.real?.outcome === "error"
        ? `error:${step.real.kind}`
        : step.real?.outcome === "ok"
          ? "ok"
          : "?";
    say(
      `  ${mark} ${step.label}  aws=${outcome}  divergences=${step.divergences.length}`,
    );
    for (const divergence of step.divergences) {
      say(
        `      · ${divergence.path || "<answer>"} [${divergence.reason}]  aws=${json(
          divergence.real,
        )}  fake=${json(divergence.fake)}`,
      );
    }
    if (step.note) say(`      note: ${step.note}`);
  }

  say("");
  say("── DKIM ──────────────────────────────────────────────────────────────");
  say(
    `  PRD 07 claims ${report.dkim.records.length} record(s); AWS reported origin=${
      report.dkim.awsOrigin ?? "-"
    } status=${report.dkim.awsStatus ?? "-"} tokens=${report.dkim.awsTokens.length}`,
  );
  for (const record of report.dkim.records) {
    say(`  ${record.type}  ${record.name}`);
    say(`        ${record.value}`);
  }
  // Under `EXTERNAL` these are NOT records: AWS echoes the selector we
  // supplied (SESv2 API Reference, `DkimAttributes`), so printing them as
  // unexpected CNAMEs told a reader the one-record claim had broken when it
  // had not. Under `AWS_SES` they are exactly that, and the note above says so.
  for (const token of report.dkim.awsTokens) {
    say(
      report.dkim.awsOrigin === "EXTERNAL"
        ? `  selector echoed by SES (no record implied)  ${token}`
        : `  CNAME (Easy DKIM — an EXTRA record)  ${token}`,
    );
  }

  if (report.notes.length > 0) {
    say("");
    say(
      "── notes ─────────────────────────────────────────────────────────────",
    );
    for (const note of report.notes) say(`  • ${note}`);
  }

  say("");
  say("── teardown ──────────────────────────────────────────────────────────");
  if (report.cleanup.order.length === 0) {
    say("  nothing was created");
  } else {
    for (const label of report.cleanup.order) {
      const failure = report.cleanup.failed.find(
        (candidate) => candidate.label === label,
      );
      say(failure ? `  ✗ ${label} — ${failure.error}` : `  ✓ ${label}`);
    }
  }
  if (report.cleanup.failed.length > 0) {
    say("");
    say(
      `  ⚠ ${report.cleanup.failed.length} resource(s) could NOT be removed and are still billing. Sweep them by hand.`,
    );
  }

  say("");
  say("═".repeat(72));
  if (report.aborted) say(`ABORTED: ${report.aborted}`);
  const compared = report.steps.filter(
    (step) => step.status === "compared",
  ).length;
  const skipped = report.steps.length - compared;
  say(
    `${compared} verb call(s) compared, ${skipped} skipped, ${report.divergences.length} divergence(s), ${report.cleanup.failed.length} resource(s) left behind`,
  );
  say(
    report.divergences.length === 0 &&
      report.cleanup.failed.length === 0 &&
      !report.aborted
      ? "The Fake told the truth for everything this run exercised."
      : "The Fake and AWS DISAGREE. Every divergence above is a production-only bug with a green test in front of it.",
  );
  say("═".repeat(72));

  return lines.join("\n");
}

function json(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/**
 * Replace every occurrence of each secret with a marker.
 *
 * Applied to the WHOLE rendered output rather than to individual fields,
 * because the thing most likely to leak is the one nobody thought to redact:
 * AWS's own error body, quoted verbatim by `SesError.detail`.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    scrubbed = scrubbed.split(secret).join("<redacted>");
  }
  return scrubbed;
}
