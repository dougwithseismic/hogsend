/**
 * Pure heuristics: raw admin-API metrics → ranked findings. No I/O — the unit
 * test surface for the health report. Thresholds are deliberately conservative
 * (flag the obvious, not the marginal) and every finding carries evidence +
 * one concrete suggested action so the model can chain into a fix.
 */

export interface Finding {
  severity: "critical" | "warning" | "info";
  area: string;
  finding: string;
  evidence: Record<string, unknown>;
  suggested_action: string;
  deep_link?: string;
}

// --- input shapes (subset of the admin API responses) -----------------------

export interface JourneyListItem {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { event: string };
  counts: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    exited: number;
  };
}

export interface JourneyFunnel {
  journeyId: string;
  enrolled: number;
  emailSent: number;
  emailOpened: number;
  emailClicked: number;
  completed: number;
  failed: number;
  exited: number;
}

export interface JourneyGraphMetrics {
  nodes: Array<{ id: string; type: string; title?: string }>;
  enrolled: number;
  nodeMetrics: Record<string, { live: number; failed: number }>;
}

export interface TemplateMetricsRow {
  templateKey: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  openRate: number;
  clickRate: number;
}

export interface DeliverabilityPoint {
  date: string;
  total: number;
  delivered: number;
  bounced: number;
  complained: number;
}

export interface ReadinessCheck {
  label: string;
  status: "ok" | "action" | "optional";
}

// --- heuristics --------------------------------------------------------------

/** Nodes where enrollments pile up (the literal bottleneck signal). Durable
 * node types only — instantaneous nodes legitimately hold nobody. */
export function parkedNodeFindings(
  journeyId: string,
  journeyName: string,
  graph: JourneyGraphMetrics,
  makeLink?: (path: string) => string,
): Finding[] {
  const findings: Finding[] = [];
  const durable = new Set(["sleep", "sleepUntil", "wait", "checkpoint"]);
  for (const node of graph.nodes) {
    if (!durable.has(node.type)) continue;
    const m = graph.nodeMetrics[node.id];
    if (!m) continue;
    const share = graph.enrolled > 0 ? m.live / graph.enrolled : 0;
    if (m.live >= 10 && share >= 0.2) {
      findings.push({
        severity: share >= 0.5 ? "critical" : "warning",
        area: `journeys/${journeyId}`,
        finding: `${m.live} users (${Math.round(share * 100)}% of ${graph.enrolled} enrolled) are parked at "${node.title ?? node.id}" in ${journeyName}`,
        evidence: {
          journeyId,
          nodeId: node.id,
          live: m.live,
          enrolled: graph.enrolled,
        },
        suggested_action: `Investigate why "${node.title ?? node.id}" rarely progresses — consider a nudge journey targeting users parked there, or a shorter timeout`,
        deep_link: makeLink?.(`/journeys/${journeyId}`),
      });
    }
    if (
      m.failed >= 5 &&
      graph.enrolled > 0 &&
      m.failed / graph.enrolled >= 0.1
    ) {
      findings.push({
        severity: m.failed / graph.enrolled >= 0.25 ? "critical" : "warning",
        area: `journeys/${journeyId}`,
        finding: `${m.failed} enrollments failed at "${node.title ?? node.id}" in ${journeyName}`,
        evidence: {
          journeyId,
          nodeId: node.id,
          failed: m.failed,
          enrolled: graph.enrolled,
        },
        suggested_action:
          "Check the journey's recent failure messages (journey states with status=failed) for this node",
        deep_link: makeLink?.(`/journeys/${journeyId}`),
      });
    }
  }
  return findings;
}

/** Stage-to-stage funnel drop-offs beyond conservative floors. */
export function funnelFindings(
  journeyId: string,
  journeyName: string,
  funnel: JourneyFunnel,
  makeLink?: (path: string) => string,
): Finding[] {
  const findings: Finding[] = [];
  const link = makeLink?.(`/journeys/${journeyId}`);
  if (funnel.emailSent >= 20 && funnel.emailOpened / funnel.emailSent < 0.15) {
    findings.push({
      severity: "warning",
      area: `journeys/${journeyId}`,
      finding: `${journeyName} loses ${Math.round((1 - funnel.emailOpened / funnel.emailSent) * 100)}% between send and open (${funnel.emailOpened}/${funnel.emailSent} opened)`,
      evidence: {
        journeyId,
        emailSent: funnel.emailSent,
        emailOpened: funnel.emailOpened,
      },
      suggested_action:
        "Its subject lines underperform — draft alternates for the journey's templates and preview them",
      deep_link: link,
    });
  }
  if (
    funnel.emailOpened >= 20 &&
    funnel.emailClicked / funnel.emailOpened < 0.03
  ) {
    findings.push({
      severity: "info",
      area: `journeys/${journeyId}`,
      finding: `${journeyName} converts only ${funnel.emailClicked}/${funnel.emailOpened} opens into clicks`,
      evidence: {
        journeyId,
        emailOpened: funnel.emailOpened,
        emailClicked: funnel.emailClicked,
      },
      suggested_action: "Review the email bodies' calls-to-action",
      deep_link: link,
    });
  }
  if (funnel.enrolled >= 20 && funnel.failed / funnel.enrolled >= 0.1) {
    findings.push({
      severity:
        funnel.failed / funnel.enrolled >= 0.25 ? "critical" : "warning",
      area: `journeys/${journeyId}`,
      finding: `${funnel.failed} of ${funnel.enrolled} enrollments in ${journeyName} FAILED`,
      evidence: { journeyId, failed: funnel.failed, enrolled: funnel.enrolled },
      suggested_action: "Inspect failed journey states for the error message",
      deep_link: link,
    });
  }
  return findings;
}

/** Enabled journeys that never enrolled anyone — dead triggers. */
export function deadTriggerFindings(
  journeys: JourneyListItem[],
  makeLink?: (path: string) => string,
): Finding[] {
  return journeys
    .filter((j) => {
      const c = j.counts;
      const total = c.active + c.waiting + c.completed + c.failed + c.exited;
      return j.enabled && total === 0;
    })
    .map((j) => ({
      severity: "info" as const,
      area: `journeys/${j.id}`,
      finding: `${j.name} is enabled but has never enrolled anyone (trigger: "${j.trigger.event}")`,
      evidence: { journeyId: j.id, trigger: j.trigger.event },
      suggested_action:
        "Verify the trigger event name is actually fired by your app (check recent events), or disable the journey",
      deep_link: makeLink?.(`/journeys/${j.id}`),
    }));
}

/** Worst-performing templates by open rate (enough volume to mean something). */
export function templateFindings(
  rows: TemplateMetricsRow[],
  makeLink?: (path: string) => string,
): Finding[] {
  return rows
    .filter((r) => r.sent >= 50 && r.openRate < 15)
    .sort((a, b) => a.openRate - b.openRate)
    .slice(0, 3)
    .map((r) => ({
      severity: "warning" as const,
      area: `templates/${r.templateKey}`,
      finding: `Template "${r.templateKey}" opens at only ${r.openRate}% across ${r.sent} sends`,
      evidence: {
        templateKey: r.templateKey,
        sent: r.sent,
        openRate: r.openRate,
      },
      suggested_action: "Draft two alternative subject lines and preview them",
      deep_link: makeLink?.(`/templates/${r.templateKey}`),
    }));
}

/** Bounce/complaint pressure vs provider ceilings (Gmail complaint cap 0.3%). */
export function deliverabilityFindings(
  points: DeliverabilityPoint[],
): Finding[] {
  const total = points.reduce((a, p) => a + p.total, 0);
  const delivered = points.reduce((a, p) => a + p.delivered, 0);
  const bounced = points.reduce((a, p) => a + p.bounced, 0);
  const complained = points.reduce((a, p) => a + p.complained, 0);
  if (total < 50) return []; // not enough volume to judge
  const findings: Finding[] = [];
  const bounceRate = bounced / total;
  if (bounceRate >= 0.02) {
    findings.push({
      severity: bounceRate >= 0.05 ? "critical" : "warning",
      area: "deliverability",
      finding: `Bounce rate is ${(bounceRate * 100).toFixed(1)}% over the window (${bounced}/${total})`,
      evidence: { bounced, total },
      suggested_action:
        "Clean the list: suppress hard bounces and review where these addresses came from",
    });
  }
  const complaintRate = delivered > 0 ? complained / delivered : 0;
  if (complaintRate >= 0.001) {
    findings.push({
      severity: complaintRate >= 0.003 ? "critical" : "warning",
      area: "deliverability",
      finding: `Complaint rate is ${(complaintRate * 100).toFixed(2)}% (Gmail's ceiling is 0.3%)`,
      evidence: { complained, delivered },
      suggested_action:
        "Reduce send frequency to unengaged users and check consent on your marketing lists",
    });
  }
  return findings;
}

/** Setup checks still in the "action" state. */
export function readinessFindings(checks: ReadinessCheck[]): Finding[] {
  return checks
    .filter((c) => c.status === "action")
    .map((c) => ({
      severity: "info" as const,
      area: "setup",
      finding: `Setup incomplete: ${c.label}`,
      evidence: { label: c.label },
      suggested_action: "Complete this in Studio's setup checklist",
    }));
}
