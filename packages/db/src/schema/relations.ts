import { relations } from "drizzle-orm";
import {
  account,
  invitation,
  member,
  organization,
  session,
  user,
} from "./auth.js";
import { emailSends } from "./email-sends.js";
import { journeyLogs } from "./journey-logs.js";
import { journeyStates } from "./journey-states.js";
import { linkClicks } from "./link-clicks.js";
import { trackedLinks } from "./tracked-links.js";

export const journeyStatesRelations = relations(journeyStates, ({ many }) => ({
  logs: many(journeyLogs),
  emailSends: many(emailSends),
}));

export const journeyLogsRelations = relations(journeyLogs, ({ one }) => ({
  journeyState: one(journeyStates, {
    fields: [journeyLogs.journeyStateId],
    references: [journeyStates.id],
  }),
}));

export const emailSendsRelations = relations(emailSends, ({ one, many }) => ({
  journeyState: one(journeyStates, {
    fields: [emailSends.journeyStateId],
    references: [journeyStates.id],
  }),
  trackedLinks: many(trackedLinks),
}));

export const trackedLinksRelations = relations(
  trackedLinks,
  ({ one, many }) => ({
    emailSend: one(emailSends, {
      fields: [trackedLinks.emailSendId],
      references: [emailSends.id],
    }),
    clicks: many(linkClicks),
  }),
);

export const linkClicksRelations = relations(linkClicks, ({ one }) => ({
  trackedLink: one(trackedLinks, {
    fields: [linkClicks.trackedLinkId],
    references: [trackedLinks.id],
  }),
}));

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(member),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  inviter: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));
