import {
  APPEAL_EMAIL,
  AUP_CLAUSES,
  type AupClause,
  formatRate,
  hasAppeal,
} from "./email-abuse-policy";

/**
 * THE SUSPENSION NOTICE (PRD 08 task 7).
 *
 * The copy is `docs/hogsend-email-terms.md` Part B and is NOT rewritten here.
 * It was written to arrive at a bad moment — mid-campaign, as a surprise — and
 * to do four jobs: say what happened, say which clause, show the numbers, and
 * give one clear next action. This module renders it and nothing else.
 *
 * Three deviations from the document, each forced and each named:
 *
 *  1. **Plain text only.** `EmailSender` is the control plane's one transport
 *     and it carries `{ to, subject, text }`. The document's preheader has
 *     nowhere to go in a text/plain message, so it is dropped rather than
 *     pasted into the body where it would read as a duplicated first line.
 *  2. **The measured numbers are OPTIONAL.** Variant 1 wants a metric, a
 *     measurement, a volume and a window. An EventBridge `Sending Status
 *     Disabled` carries a cause, not a rate; our own reputation sweep DOES know
 *     the numbers because it computed them. So the numbers paragraph is
 *     rendered when there are numbers and replaced by the recorded cause alone
 *     when there are not — an omission, not a rewrite, because printing
 *     "your undefined reached undefined" would be worse than either.
 *  3. **The dashboard link targets the environment's uuid, not its name.** The
 *     `/environments/:id` dashboard route resolves by id and 404s on a name, so
 *     the deep link uses `environmentId` (URL-encoded) while the human-readable
 *     name stays in the body copy.
 *
 * The clause number is load-bearing. `AUP_CLAUSES` is the only place a clause
 * is named, and §6.7's no-appeal rule for phishing and malware changes the
 * WHAT TO DO section entirely rather than softening it.
 */

export interface SuspensionMeasurement {
  /** "hard bounce rate" / "complaint rate". */
  metric: string;
  /** The measured rate, as a fraction. */
  measured: number;
  /** The limit, as a fraction. */
  threshold: number;
  /** Messages the rate was measured over. */
  volume: number;
  /** The measurement window, as a phrase: "8 August to 10 August". */
  window: string;
}

export interface SuspensionNoticeFacts {
  /**
   * `automatic` — a reputation threshold or an infrastructure pause (§6.1).
   * `manual` — a human suspending on evidence of a §2 or §3 breach (§6.2).
   */
  variant: "automatic" | "manual";
  environment: string;
  /**
   * The environment's uuid. The dashboard route resolves by id, not name, so
   * the deep link uses this; `environment` stays as the human-readable display
   * text.
   */
  environmentId: string;
  suspendedAt: Date;
  clause: AupClause | string;
  /** The recorded cause, verbatim. Always present; it is the one fact we have. */
  cause: string;
  measurement?: SuspensionMeasurement;
}

export interface RenderedNotice {
  subject: string;
  text: string;
}

/** `10 August 2026 at 14:32 UTC`, as the token table specifies. */
export function formatNoticeTimestamp(at: Date): string {
  const date = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  // `hourCycle: "h23"` rather than `hour12: false`: the latter renders
  // midnight as "24:00" under some ICU versions, and a suspension notice
  // stamped "24:00" reads as a bug in the thing that just stopped your mail.
  const time = at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
  return `${date} at ${time} UTC`;
}

/** `8 August to 10 August` — the measurement window, in the document's shape. */
export function formatNoticeWindow(from: Date, to: Date): string {
  const day = (at: Date) =>
    at.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  return `${day(from)} to ${day(to)}`;
}

function clauseTitle(clause: string): string {
  return (AUP_CLAUSES as Record<string, string>)[clause] ?? "Acceptable use";
}

function whatHappened(facts: SuspensionNoticeFacts): string[] {
  const title = clauseTitle(facts.clause);

  if (facts.variant === "manual") {
    return [
      "WHAT HAPPENED",
      "",
      "We suspended sending after reviewing activity on this environment. It",
      `breaches clause ${facts.clause} of the Hogsend Email Acceptable Use`,
      `Policy, ${title}.`,
      "",
      facts.cause,
      "",
      "Clause 6.2 allows us to suspend immediately where continued sending",
      "would put other customers' delivery at risk.",
    ];
  }

  const lines = ["WHAT HAPPENED", ""];
  const measured = facts.measurement;
  if (measured) {
    lines.push(
      `Your ${measured.metric} reached ${formatRate(measured.measured)} across`,
      `${measured.volume.toLocaleString("en-GB")} messages sent between`,
      `${measured.window}. The limit is ${formatRate(measured.threshold)}.`,
      "",
    );
  }
  lines.push(
    `This breaches clause ${facts.clause} of the Hogsend Email Acceptable Use`,
    `Policy, ${title}. The suspension was automatic, which clause 6.1 allows,`,
    "because at that rate every additional send makes the problem harder to",
    "recover from.",
    "",
    `Recorded cause: ${facts.cause}`,
  );
  return lines;
}

function whatToDo(facts: SuspensionNoticeFacts): string[] {
  // §6.7: phishing and malware end sending permanently, and the section is
  // REPLACED rather than qualified. A "reply and tell us three things" under a
  // clause with no appeal would be an invitation we would have to refuse.
  if (!hasAppeal(facts.clause)) {
    return [
      "WHAT TO DO",
      "",
      "Nothing. Clause 6.7 of the Acceptable Use Policy provides no appeal for",
      "this clause. Sending from this environment has ended permanently.",
    ];
  }

  const metric = facts.measurement?.metric ?? "problem";
  return [
    "WHAT TO DO",
    "",
    "Reply to this email and tell us three things:",
    "",
    `1. What caused the ${metric}. The usual answers are a list that was`,
    "   imported rather than collected, a segment that had not been mailed in",
    "   a long time, or a send that went to addresses gathered for a different",
    "   purpose.",
    "2. What you have changed.",
    "3. What list you will send to when sending resumes, and where those",
    "   addresses came from.",
    "",
    "A person reads every reply. We aim to respond within one working day.",
    "",
    "Reinstatement is not automatic and we cannot grant it on request alone.",
    "Sending resumed over an unresolved cause suspends again within days, and",
    "the second suspension is harder to recover from than the first. That is",
    "why the questions above are the whole process.",
  ];
}

export function renderSuspensionNotice(
  facts: SuspensionNoticeFacts,
): RenderedNotice {
  const lines = [
    `Sending is suspended for your ${facts.environment} environment as of`,
    `${formatNoticeTimestamp(facts.suspendedAt)}.`,
    "",
    ...whatHappened(facts),
    "",
    "WHAT THIS AFFECTS",
    "",
    `Sending from ${facts.environment} only. Every send attempt now fails with`,
    "this reason instead of queueing, so nothing is sitting in a backlog",
    "waiting to go out when this resolves. Your other environments are",
    "unaffected.",
    "",
    "Everything else keeps running: event ingestion, journeys, contacts, the",
    "API, and Studio. Your data is untouched.",
    "",
    ...whatToDo(facts),
    "",
    "Full policy: https://hogsend.com/acceptable-use",
    `Your sending status: https://cloud.hogsend.com/environments/${encodeURIComponent(facts.environmentId)}`,
    "",
    `Appeals: ${APPEAL_EMAIL}`,
  ];

  return {
    subject: `Sending suspended for ${facts.environment}`,
    text: lines.join("\n"),
  };
}

/**
 * Variant 3 — reinstatement.
 *
 * Not required by PRD 08 task 7, and included for the reason the document gives
 * for writing it: a suspension notice that promises a way back needs its other
 * half, and a customer who fixes the problem and hears nothing assumes we
 * forgot. Rendered here so the copy has one home; the caller decides when.
 */
export function renderReinstatementNotice(facts: {
  environment: string;
  environmentId: string;
}): RenderedNotice {
  return {
    subject: `Sending restored for ${facts.environment}`,
    text: [
      `Sending is available again for your ${facts.environment} environment.`,
      "",
      "Your account is on the watched tier. Automated enforcement is set to",
      "pause on any reputation finding, including a low severity one, and your",
      "sending cap is reduced until the record is clean again. Bulk list import",
      "stays unavailable at this tier.",
      "",
      "Start smaller than you finished. Your most recently engaged recipients",
      "first, then widen once the rates hold. Your bounce and complaint rates",
      "are on your dashboard and are what decides how quickly the cap comes",
      "back.",
      "",
      `Your sending status: https://cloud.hogsend.com/environments/${encodeURIComponent(facts.environmentId)}`,
    ].join("\n"),
  };
}
