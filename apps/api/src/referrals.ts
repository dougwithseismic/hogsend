import { defineReferral } from "@hogsend/core";
import { Events } from "./journeys/constants/index.js";

/**
 * The dogfood referral: one shared link per contact, earned when the
 * referee's subscription starts. Model, depth and weights are chosen at
 * report time (`GET /v1/referrals/report`), never here.
 */
export const inviteReferral = defineReferral({
  id: "invite",
  link: {
    destination: process.env.REFERRAL_DESTINATION_URL ?? "https://hogsend.com",
    campaign: "invite",
  },
  qualify: { event: Events.SUBSCRIPTION_CREATED },
});

export const referrals = [inviteReferral];
