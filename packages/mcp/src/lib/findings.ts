/**
 * PURE heuristic functions for `hogsend_report`. The tool does all the
 * fetching; these functions take the fetched admin-API payloads and compute a
 * `Finding[]`. Keeping them side-effect-free (the only ambient input is a `now`
 * clock, passed in) makes every threshold unit-testable against fixtures with a
 * fixed clock.
 *
 * Every threshold below is intentionally CONSERVATIVE and carries a one-line
 * rationale — the report must not cry wolf. A finding fires only when the
 * evidence is strong enough that a practitioner would act on it.
 */

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  evidence: string;
  suggested_action: string;
}

// ---------------------------------------------------------------------------
// Thresholds (each documented with its rationale)
// ---------------------------------------------------------------------------

/**
 * A blueprint enabled at least this long ago that has STILL enrolled nobody
 * almost certainly has a trigger event that never fires (a typo or the wrong
 * name). Below this age a zero-enrollment enabled blueprint is just new.
 */
export const DEAD_TRIGGER_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Below this many sends, an open rate is statistical noise — never flag it. */
export const FUNNEL_MIN_SENDS = 50;
/** Below this many opens, a click rate is statistical noise — never flag it. */
export const FUNNEL_MIN_OPENS = 50;
/**
 * Open rate well under any healthy baseline (typical is 20–40%). A sustained
 * sub-10% rate over 50+ sends signals a subject/deliverability/tracking
 * problem, not normal variance.
 */
export const LOW_OPEN_RATE = 0.1;

/** Deliverability aggregate floor — rates are meaningless below this volume. */
export const DELIVERABILITY_MIN_SENDS = 100;
/** Mailbox providers throttle senders around a 5% bounce rate… */
export const BOUNCE_WARN_RATE = 0.05;
/** …and risk blocklisting past ~10%. */
export const BOUNCE_CRIT_RATE = 0.1;
/** Gmail/Postmark treat 0.1% spam complaints as the red line… */
export const COMPLAINT_WARN_RATE = 0.001;
/** …and >0.5% is severe. */
export const COMPLAINT_CRIT_RATE = 0.005;
/** A delivery rate under 90% at volume points at SPF/DKIM/DMARC or list hygiene. */
export const LOW_DELIVERY_RATE = 0.9;

// ---------------------------------------------------------------------------
// Input payload shapes (subsets of the admin-route responses actually used)
// ---------------------------------------------------------------------------

export interface ReadinessCheck {
  id: string;
  label: string;
  status: "ok" | "action" | "optional";
  detail: string;
  docsUrl?: string;
}
export interface Readiness {
  checks: ReadinessCheck[];
}

export interface StateCounts {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  exited: number;
}

export interface BlueprintListItem {
  id: string;
  name: string;
  status: "draft" | "enabled" | "disabled";
  triggerEvent: string;
  // Enable/disable and every write bump `updatedAt`, so it is the best available
  // proxy for "when did this last change state" (there is no `enabledAt`).
  updatedAt: string;
  promotedAt: string | null;
  counts: StateCounts;
}

export interface JourneyListItem {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { event: string };
  counts: StateCounts;
}

export interface JourneyMetric {
  journeyId: string;
  enrolled: number;
}

/** A send→open→click funnel row — journey- or template-scoped. */
export interface FunnelEntry {
  id: string;
  label: string;
  sent: number;
  opened: number;
  clicked: number;
}

export interface DeliverabilityPoint {
  date: string;
  total: number;
  delivered: number;
  bounced: number;
  complained: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROMOTE_HINT =
  "To turn a validated blueprint into a code journey, run `hogsend blueprints promote`.";

function pct(n: number, d: number): string {
  if (d <= 0) return "0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function totalEnrollments(c: StateCounts): number {
  return c.active + c.waiting + c.completed + c.failed + c.exited;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Readiness "action" items become findings. `email_provider`, `hatchet`, and
 * `data_plane_key` are critical (sends fail / journeys can't run / nothing
 * ingests); other action items (e.g. sending domain) are warnings. "ok" and
 * "optional" rows are not findings.
 */
const CRITICAL_READINESS = new Set([
  "email_provider",
  "hatchet",
  "data_plane_key",
]);

export function readinessFindings(readiness: Readiness): Finding[] {
  const findings: Finding[] = [];
  for (const check of readiness.checks) {
    if (check.status !== "action") continue;
    findings.push({
      id: `readiness:${check.id}`,
      severity: CRITICAL_READINESS.has(check.id) ? "critical" : "warning",
      title: `Setup incomplete: ${check.label}`,
      evidence: check.detail,
      suggested_action: check.docsUrl
        ? `Resolve "${check.label}". See ${check.docsUrl}.`
        : `Resolve "${check.label}".`,
    });
  }
  return findings;
}

/**
 * A dead blueprint trigger: an ENABLED, non-promoted blueprint that has enrolled
 * nobody AND has sat unchanged for at least {@link DEAD_TRIGGER_MIN_AGE_MS}. The
 * gate uses `updatedAt` (enable bumps it) rather than `createdAt`, so a blueprint
 * enabled today off an old draft is NOT flagged.
 */
export function deadBlueprintTriggerFindings(
  blueprints: BlueprintListItem[],
  now: Date,
): Finding[] {
  const findings: Finding[] = [];
  for (const bp of blueprints) {
    if (bp.status !== "enabled") continue;
    if (bp.promotedAt) continue; // promoted blueprints are disabled by design
    if (totalEnrollments(bp.counts) > 0) continue;
    const updatedMs = Date.parse(bp.updatedAt);
    if (Number.isNaN(updatedMs)) continue;
    if (now.getTime() - updatedMs < DEAD_TRIGGER_MIN_AGE_MS) continue;
    findings.push({
      id: `dead-blueprint:${bp.id}`,
      severity: "warning",
      title: `Blueprint "${bp.id}" is enabled but never enrolls`,
      evidence:
        `Blueprint "${bp.id}" (${bp.name}) is enabled with trigger event ` +
        `"${bp.triggerEvent}", unchanged since ${bp.updatedAt}, but has enrolled 0 users.`,
      suggested_action:
        `Confirm "${bp.triggerEvent}" is actually emitted (hogsend_report scope=catalog ` +
        `lists observed event names), fix the trigger via manage_blueprint update, or ` +
        `disable it. ${PROMOTE_HINT}`,
    });
  }
  return findings;
}

/**
 * A dead CODE-journey trigger: an enabled journey with zero enrollments. Code
 * journeys carry no created-at, so there is no age gate here — the finding is
 * phrased to allow "may simply be newly deployed".
 */
export function deadJourneyTriggerFindings(
  journeys: JourneyListItem[],
  metrics: JourneyMetric[],
): Finding[] {
  const enrolledById = new Map(metrics.map((m) => [m.journeyId, m.enrolled]));
  const findings: Finding[] = [];
  for (const j of journeys) {
    if (!j.enabled) continue;
    const enrolled = enrolledById.get(j.id) ?? totalEnrollments(j.counts);
    if (enrolled > 0) continue;
    findings.push({
      id: `dead-journey:${j.id}`,
      severity: "warning",
      title: `Journey "${j.id}" is enabled but never enrolls`,
      evidence:
        `Journey "${j.id}" (${j.name}) is enabled with trigger event ` +
        `"${j.trigger.event}" but has enrolled 0 users.`,
      suggested_action:
        `Confirm "${j.trigger.event}" is actually emitted (hogsend_report ` +
        `scope=catalog), or the journey may simply be newly deployed.`,
    });
  }
  return findings;
}

/**
 * Send→open→click funnel drop-off, reused for journeys and templates. Two
 * conservative signals per entry: a low open rate over enough sends (warning),
 * and a total absence of clicks over enough opens (info) — a zero, not a
 * low-but-nonzero CTR, since naturally low CTRs are normal.
 */
export function funnelFindings(entries: FunnelEntry[]): Finding[] {
  const findings: Finding[] = [];
  for (const e of entries) {
    if (e.sent >= FUNNEL_MIN_SENDS && e.opened / e.sent < LOW_OPEN_RATE) {
      findings.push({
        id: `funnel-open:${e.id}`,
        severity: "warning",
        title: `Low open rate: ${e.label}`,
        evidence:
          `${e.label}: ${e.opened} opens / ${e.sent} sends (${pct(e.opened, e.sent)}), ` +
          `below the ${LOW_OPEN_RATE * 100}% floor.`,
        suggested_action:
          "Check subject lines and sender reputation (SPF/DKIM/DMARC via " +
          "hogsend_report scope=health/deliverability); confirm open tracking isn't blocked.",
      });
    }
    if (e.opened >= FUNNEL_MIN_OPENS && e.clicked === 0) {
      findings.push({
        id: `funnel-click:${e.id}`,
        severity: "info",
        title: `No clicks recorded: ${e.label}`,
        evidence: `${e.label}: 0 clicks despite ${e.opened} opens.`,
        suggested_action:
          "Verify the email has a working, tracked call-to-action link (unsubscribe/preference links are not tracked).",
      });
    }
  }
  return findings;
}

/**
 * Deliverability aggregate over the returned time-series points: bounce,
 * complaint, and delivery rates vs sane thresholds. Gated on
 * {@link DELIVERABILITY_MIN_SENDS} total so a handful of sends can't trip it.
 */
export function deliverabilityFindings(
  points: DeliverabilityPoint[],
): Finding[] {
  const total = points.reduce((a, p) => a + p.total, 0);
  if (total < DELIVERABILITY_MIN_SENDS) return [];

  const delivered = points.reduce((a, p) => a + p.delivered, 0);
  const bounced = points.reduce((a, p) => a + p.bounced, 0);
  const complained = points.reduce((a, p) => a + p.complained, 0);
  const findings: Finding[] = [];

  // Past the MIN_SENDS gate `points` is guaranteed non-empty.
  const window = `${points[0]?.date} → ${points.at(-1)?.date}`;

  const bounceRate = bounced / total;
  if (bounceRate >= BOUNCE_WARN_RATE) {
    findings.push({
      id: "deliverability:bounce",
      severity: bounceRate >= BOUNCE_CRIT_RATE ? "critical" : "warning",
      title: "Elevated bounce rate",
      evidence: `${bounced} bounces / ${total} sends (${pct(bounced, total)}) over ${window}.`,
      suggested_action:
        "Remove hard-bounced addresses and mail only opted-in, verified contacts — high bounce rates get senders throttled or blocklisted.",
    });
  }

  const complaintRate = complained / total;
  if (complaintRate >= COMPLAINT_WARN_RATE) {
    findings.push({
      id: "deliverability:complaint",
      severity: complaintRate >= COMPLAINT_CRIT_RATE ? "critical" : "warning",
      title: "Elevated spam-complaint rate",
      evidence: `${complained} complaints / ${total} sends (${pct(complained, total)}) over ${window}.`,
      suggested_action:
        "Reduce send frequency, tighten targeting, and keep a visible unsubscribe — complaint rates above 0.1% risk blocklisting.",
    });
  }

  const deliveryRate = delivered / total;
  if (deliveryRate < LOW_DELIVERY_RATE) {
    findings.push({
      id: "deliverability:delivery",
      severity: "warning",
      title: "Low delivery rate",
      evidence: `${delivered} delivered / ${total} sends (${pct(delivered, total)}) over ${window}.`,
      suggested_action:
        "Verify SPF/DKIM/DMARC for your sending domain (hogsend_report scope=health) and check list hygiene.",
    });
  }

  return findings;
}
