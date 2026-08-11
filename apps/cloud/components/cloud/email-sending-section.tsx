import type { JSX, ReactNode } from "react";
import { TimeAgo } from "@/components/cloud/time-ago";
import { TagPill } from "@/components/ds/badge";
import { Hairline } from "@/components/ds/decor";
import type { EmailTrustTier } from "@/src/lib/email-abuse-policy";
import type { EmailSendingView } from "@/src/lib/email-abuse-view";
import type { EmailSendingStatusValue } from "@/src/services/email-sending-status";

/**
 * One environment's Hogsend Email standing (PRD 08 task 8).
 *
 * **OBSERVE-ONLY, on purpose, and this is the panel where that matters most.**
 * There is no unpause button and no tier control here, because appeals are a
 * human queue (AUP §6.6) and reinstatement is never granted on request alone —
 * a button would be an automatic bypass wearing a UI. The operator lever is
 * `reinstateEmailSending`, a function called with a name recorded against it.
 *
 * What it DOES show is everything a person needs before making that call: the
 * status and the recorded cause, the tier and what the tier costs, the open
 * findings, and the pause history — because AUP §6.4's "a second suspension for
 * the same clause" cannot be applied by someone who can only see the current
 * one.
 */

const STATUS_TONE: Record<
  EmailSendingStatusValue,
  "neutral" | "accent" | "good" | "caution"
> = {
  active: "good",
  // Both blocking states are red rather than amber. A tenant that cannot send
  // is not "in progress"; every journey it runs is failing right now.
  paused: "accent",
  enforced: "accent",
  reinstated: "caution",
};

const TIER_TONE: Record<EmailTrustTier, "neutral" | "good" | "caution"> = {
  new: "neutral",
  established: "good",
  watched: "caution",
};

/** What each status MEANS, in the terms an appeal is argued in. */
const STATUS_NOTE: Record<EmailSendingStatusValue, string> = {
  active: "Sending normally.",
  paused:
    "Stopped by AWS's own reputation policy. Every send fails closed with the recorded cause; nothing is queued.",
  enforced:
    "Stopped by Hogsend under the Acceptable Use Policy. Every send fails closed with the recorded cause; nothing is queued.",
  reinstated:
    "Sending again after a previous stop. The record of the stop is kept deliberately.",
};

const TIER_NOTE: Record<EmailTrustTier, string> = {
  new: "Observed rather than auto-paused, and bounded by a daily cap instead. Promotes automatically on a clean sending record.",
  established:
    "Auto-pauses on high-severity findings. The plan allowance is the only ceiling.",
  watched:
    "Auto-pauses on any finding, including low severity. Promotion out of this tier is a human review, never automatic.",
};

function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <span className="font-medium text-sm text-white/80 tracking-[-0.02em]">
        {label}
      </span>
      <span className="text-right text-sm text-white/60 sm:max-w-[60%]">
        {children}
      </span>
    </div>
  );
}

function capLine(view: EmailSendingView): string {
  if (!view.cap) {
    return "no tier cap — the plan allowance is the only ceiling";
  }
  const period = view.cap.window === "day" ? "today" : "this billing period";
  return `${view.usedInCapWindow.toLocaleString("en-GB")} of ${view.cap.limit.toLocaleString(
    "en-GB",
  )} ${period}`;
}

export function EmailSendingSection({
  view,
  now,
}: {
  view: EmailSendingView;
  now?: Date;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <Row label="Sending status">
        <span className="flex flex-col items-end gap-2">
          <TagPill tone={STATUS_TONE[view.status]}>{view.status}</TagPill>
          <span>{STATUS_NOTE[view.status]}</span>
        </span>
      </Row>

      {/*
        The recorded cause, verbatim and not summarised. It is the same sentence
        the relay's 403 carries and the same one the customer's journeys have
        recorded, so paraphrasing it here would mean an operator and a customer
        reading two different explanations of one event.
      */}
      {view.reason ? (
        <>
          <Hairline />
          <Row label="Recorded cause">
            <span className="text-white/75">{view.reason}</span>
          </Row>
        </>
      ) : null}

      {view.pausedAt ? (
        <>
          <Hairline />
          <Row label="Stopped">
            <TimeAgo at={view.pausedAt} now={now} />
          </Row>
        </>
      ) : null}

      <Hairline />
      <Row label="Trust tier">
        <span className="flex flex-col items-end gap-2">
          <TagPill tone={TIER_TONE[view.tier]}>{view.tier}</TagPill>
          <span>{TIER_NOTE[view.tier]}</span>
        </span>
      </Row>

      <Hairline />
      <Row label="Send cap">{capLine(view)}</Row>

      <Hairline />
      <Row label="Bulk list import">
        {view.bulkImportAllowed
          ? "available"
          : "blocked below the established tier (AUP §5.3)"}
      </Row>

      <Hairline />
      <Row label="Open findings">
        {view.openFindings.length === 0 ? (
          "none"
        ) : (
          <span className="flex flex-col items-end gap-2">
            {view.openFindings.map((finding) => (
              <span key={finding.id} className="flex flex-col items-end gap-1">
                <span className="flex items-center gap-2">
                  <TagPill tone="caution">{finding.type}</TagPill>
                  {finding.impact ? (
                    <span className="text-white/50 text-xs">
                      {finding.impact}
                    </span>
                  ) : null}
                </span>
                {finding.description ? (
                  <span className="text-white/60">{finding.description}</span>
                ) : null}
              </span>
            ))}
          </span>
        )}
      </Row>

      <Hairline />
      <Row label="Pause history">
        {view.pauseHistory.length === 0 ? (
          "never stopped"
        ) : (
          <span className="flex flex-col items-end gap-1.5">
            {view.pauseHistory.map((entry) => (
              <span key={entry.id} className="flex items-center gap-2">
                <TagPill tone={STATUS_TONE[entry.status]}>
                  {entry.status}
                </TagPill>
                <span className="text-white/50 text-xs">
                  via {entry.source}
                </span>
                <TimeAgo at={entry.at} now={now} className="text-white/50" />
              </span>
            ))}
          </span>
        )}
      </Row>

      {/*
        Said out loud rather than left to be inferred from an absent button. An
        operator who cannot find the control needs to know it is missing by
        design, or the next thing they do is go looking for the database.
      */}
      <Hairline />
      <div className="px-6 py-4 text-white/45 text-xs">
        This panel is read-only. Reinstating a suspended environment is a human
        review under Acceptable Use Policy §6.6 and is never granted on request
        alone — reply to the suspension notice or write to abuse@hogsend.com.
      </div>
    </div>
  );
}
