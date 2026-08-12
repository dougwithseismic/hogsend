import type { SesRegion } from "../ses/types";
import type { CleanupFailure, CleanupReport } from "../ses-walkthrough/cleanup";
import type { SubstrateRegion } from "../substrate/types";
import type { ProofNames } from "./naming";
import type { ObservedEvent } from "./observe";
import type { ProofLink, ProofStep } from "./proof";

/**
 * Rendering only, same contract as the walkthrough's report module: every
 * decision was made elsewhere, and the ONE rule with teeth is that a bare pass
 * is a failure — the chain section names EVERY link, exercised or not, because
 * "which links were exercised and which were not" is a PRD 19 EARS criterion,
 * not a nicety. Findings get their own shouted section: a suppressed simulator
 * bounce buried in prose is a finding nobody acts on.
 */

export interface DeliveryProofReport {
  runId: string;
  region: SubstrateRegion;
  awsRegion: SesRegion;
  clientId: string;
  publicUrl: string;
  sendFrom: string;
  topicArn: string;
  names: ProofNames;
  /** Tenants from an earlier walkthrough/proof run. Reported, never touched. */
  leftoverTenants: string[];
  /** ALL of {@link PROOF_LINK_IDS}, `tunnel_health` included. */
  links: ProofLink[];
  steps: ProofStep[];
  events: ObservedEvent[];
  stub: { received: number; signatureFailures: number };
  findings: string[];
  notes: string[];
  cleanup: CleanupReport;
  probeMessageId?: string;
  aborted?: string;
}

const MARK: Record<ProofLink["status"], string> = {
  exercised: "✓",
  not_exercised: "○",
  failed: "✗",
};

export function renderProofReport(report: DeliveryProofReport): string {
  const lines: string[] = [];
  const say = (line = "") => lines.push(line);

  say("═".repeat(72));
  say(`SES delivery proof — run ${report.runId}`);
  say("═".repeat(72));
  say(
    `client=${report.clientId} region=${report.region} aws_region=${report.awsRegion}`,
  );
  say(`tenant=${report.names.tenantName}`);
  say(`configuration-set=${report.names.configurationSetName}`);
  say(`public-url=${report.publicUrl}`);
  say(`send-from=${report.sendFrom}`);
  say(`topic=${report.topicArn}`);
  if (report.leftoverTenants.length > 0) {
    say("");
    say(
      `⚠ ${report.leftoverTenants.length} tenant(s) from an EARLIER run are still in this account:`,
    );
    for (const name of report.leftoverTenants) say(`    ${name}`);
    say("  They are sweepable by name; this run did not touch them.");
  }

  say("");
  say("── the chain, link by link ───────────────────────────────────────────");
  for (const link of report.links) {
    const status =
      link.status === "not_exercised"
        ? "NOT exercised"
        : link.status === "failed"
          ? "FAILED"
          : "exercised";
    say(`  ${MARK[link.status]} ${link.id}  ${status}`);
    say(`      ${link.title}`);
    say(`      ${link.detail}`);
  }

  say("");
  say("── events ────────────────────────────────────────────────────────────");
  if (report.events.length === 0) {
    say("  no sends were made, so no events were expected");
  }
  for (const event of report.events) {
    if (!event.arrived) {
      say(
        `  ✗ ${event.scenario}  message=${event.messageId}  NEVER ARRIVED (expected ${event.expectedType})`,
      );
      continue;
    }
    const mark = event.typeMatches && event.status === "delivered" ? "✓" : "✗";
    say(
      `  ${mark} ${event.scenario}  message=${event.messageId}  type=${event.type} status=${event.status} attempts=${event.attempts}`,
    );
    if (event.lastError) say(`      last error: ${event.lastError}`);
  }
  say(
    `  stub instance: ${report.stub.received} delivery(ies) received, ${report.stub.signatureFailures} signature failure(s)`,
  );
  if (report.probeMessageId) {
    say(
      `  suppression probe: message ${report.probeMessageId} — judged by its own bounce subtype (see suppression_check above)`,
    );
  }

  if (report.findings.length > 0) {
    say("");
    say(
      "‼‼ FINDINGS ‼‼ ───────────────────────────────────────────────────────",
    );
    for (const finding of report.findings) say(`  ‼ FINDING: ${finding}`);
  }

  if (report.notes.length > 0) {
    say("");
    say(
      "── notes ─────────────────────────────────────────────────────────────",
    );
    for (const note of report.notes) say(`  • ${note}`);
  }

  say("");
  say("── steps ─────────────────────────────────────────────────────────────");
  for (const step of report.steps) {
    say(
      step.status === "ok"
        ? `  ✓ ${step.label}`
        : `  ✗ ${step.label} — ${step.detail ?? "failed"}`,
    );
  }

  say("");
  say("── teardown ──────────────────────────────────────────────────────────");
  if (report.cleanup.order.length === 0) {
    say("  nothing was created");
  } else {
    for (const label of report.cleanup.order) {
      const failure = report.cleanup.failed.find(
        (candidate: CleanupFailure) => candidate.label === label,
      );
      say(failure ? `  ✗ ${label} — ${failure.error}` : `  ✓ ${label}`);
    }
  }
  if (report.cleanup.failed.length > 0) {
    say("");
    say(
      `  ⚠ ${report.cleanup.failed.length} resource(s) could NOT be removed. Sweep them by hand.`,
    );
  }

  say("");
  say("═".repeat(72));
  if (report.aborted) say(`ABORTED: ${report.aborted}`);
  const exercised = report.links.filter(
    (link) => link.status === "exercised",
  ).length;
  const skipped = report.links.filter(
    (link) => link.status === "not_exercised",
  ).length;
  const failed = report.links.filter((link) => link.status === "failed").length;
  say(
    `${exercised} link(s) exercised, ${skipped} NOT exercised (named above), ${failed} failed, ${report.findings.length} finding(s), ${report.cleanup.failed.length} resource(s) left behind`,
  );
  say("═".repeat(72));

  return lines.join("\n");
}
