import { days } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import { DM_CAMPAIGN, LINK_CLICKED } from "./constants/discord.js";

/**
 * FEATURE A demo — a campaign that enrolls anyone who clicks a specific managed
 * link. Mint a PERSONAL link (`mintLink({ type:"personal", distinctId:<their
 * canonical key>, source:"discord", campaign: DM_CAMPAIGN })`), share it (e.g.
 * DM it in Discord); the human click re-ingests `link.clicked` keyed to their
 * contact and enrolls them here. Filter to ONE specific link instead with
 * `b.prop("linkId").eq("<the links.id mintLink returned>")`.
 *
 * NOTE: bot/unfurl prefetches are suppressed engine-side, so the Discord
 * link-preview fetch never enrolls anyone — only a real human click does.
 */
export const linkClickCampaign = defineJourney({
  meta: {
    id: "link-click-campaign",
    name: "Managed link click → DM follow-up",
    enabled: true,
    trigger: {
      event: LINK_CLICKED,
      where: (b) => b.prop("campaign").eq(DM_CAMPAIGN),
    },
    // entryLimit is the throttle for a now-routable, high-volume event — the
    // per-second idempotencyKey only dedupes the userEvents INSERT, not
    // enrollment. "once" = a given contact enrolls a single time per campaign.
    // (Never put `link.clicked` in `exitOn` unscoped — scope it to a
    // linkId/campaign, or it exits on ANY managed-link click for the contact.)
    entryLimit: "once",
    suppress: days(0),
  },
  run: async (user, _ctx) => {
    // The click resolved to this contact (the personal link carried their
    // canonical key). Follow up in the channel the link came from.
    const source = user.properties.source
      ? String(user.properties.source)
      : null;
    if (source === "discord") {
      await sendConnectorAction({
        connectorId: "discord",
        action: "dmMember",
        args: {
          member: user.id,
          content:
            "👀 Saw you opened that link — anything I can help with? " +
            "Just reply here.",
        },
      });
    }
    // Other sources (sms / referral / studio) would branch to their own channel
    // here; kept Discord-only for the dogfood.
  },
});
