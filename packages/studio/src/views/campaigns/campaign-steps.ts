import type { Campaign, CampaignStepCondition } from "@/lib/admin-api";
import { formatDuration } from "@/lib/format";

/**
 * True when the campaign runs as waves. A NULL blob or a single step is a
 * legacy single-send blast and keeps the pre-waves rendering everywhere.
 */
export function isMultiStep(
  c: Campaign,
): c is Campaign & { steps: NonNullable<Campaign["steps"]> } {
  return c.steps !== null && c.steps.length > 1;
}

/** Time until an instant — "2d 4h" — or "due now" once it has passed. */
export function formatCountdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "due now";
  return formatDuration(ms / 1000);
}

/**
 * A `where` condition as a small readable chip label — "not opened",
 * "fired account.created", "linked discord". Deliberately dumb: switch on
 * the condition's type/check, fall back to its JSON for anything unknown.
 */
export function formatStepCondition(c: CampaignStepCondition): string {
  switch (c.type) {
    case "email_engagement": {
      const verb =
        c.check === "not_opened"
          ? "not opened"
          : c.check === "not_clicked"
            ? "not clicked"
            : (c.check ?? "engaged");
      // No templateKey = scoped to any prior send of THIS campaign.
      return c.templateKey ? `${verb} ${c.templateKey}` : verb;
    }
    case "event": {
      if (typeof c.eventName !== "string") break;
      if (c.check === "exists") return `fired ${c.eventName}`;
      if (c.check === "not_exists") return `not fired ${c.eventName}`;
      return `${c.eventName} ${c.check ?? ""}`.trim();
    }
    case "channel_identity": {
      if (typeof c.connector !== "string") break;
      return c.check === "not_linked"
        ? `not linked ${c.connector}`
        : `linked ${c.connector}`;
    }
    case "property": {
      if (typeof c.property !== "string") break;
      return `${c.property} ${c.operator ?? "?"} ${JSON.stringify(
        c.value ?? null,
      )}`;
    }
  }
  return JSON.stringify(c);
}
