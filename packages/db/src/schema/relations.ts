import { relations } from "drizzle-orm";
import { alertHistory } from "./alert-history.js";
import { alertRules } from "./alert-rules.js";
import { apiKeys } from "./api-keys.js";
import { auditLogs } from "./audit-logs.js";
import {
  account,
  invitation,
  member,
  organization,
  session,
  user,
} from "./auth.js";
import { bucketConfigs } from "./bucket-configs.js";
import { bucketMemberships } from "./bucket-memberships.js";
import { contactAliases } from "./contact-aliases.js";
import { contacts } from "./contacts.js";
import { deadLetterQueue } from "./dead-letter-queue.js";
import { emailPreferences } from "./email-preferences.js";
import { emailSends } from "./email-sends.js";
import { importJobs } from "./import-jobs.js";
import { journeyConfigs } from "./journey-configs.js";
import { journeyLogs } from "./journey-logs.js";
import { journeyStates } from "./journey-states.js";
import { linkClicks } from "./link-clicks.js";
import { smsSends } from "./sms-sends.js";
import { trackedLinks } from "./tracked-links.js";
import { userEvents } from "./user-events.js";
import { webhookDeliveries } from "./webhook-deliveries.js";
import { webhookEndpoints } from "./webhook-endpoints.js";

export const alertRulesRelations = relations(alertRules, ({ many }) => ({
  history: many(alertHistory),
}));

export const alertHistoryRelations = relations(alertHistory, ({ one }) => ({
  rule: one(alertRules, {
    fields: [alertHistory.alertRuleId],
    references: [alertRules.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, () => ({}));

export const auditLogsRelations = relations(auditLogs, () => ({}));

export const deadLetterQueueRelations = relations(deadLetterQueue, () => ({}));

export const importJobsRelations = relations(importJobs, () => ({}));

export const journeyConfigsRelations = relations(journeyConfigs, () => ({}));

export const bucketConfigsRelations = relations(bucketConfigs, () => ({}));

export const contactsRelations = relations(contacts, ({ many }) => ({
  // NOTE: the logical joins below (emailPreferences/userEvents/journeyStates/
  // bucketMemberships) reference contacts.externalId — anonymous-only contacts
  // (external_id NULL) won't resolve through Drizzle relational queries until
  // identified. Acceptable (anon contacts have no prefs/journeys yet); see
  // risk 22. contacts.id is NOT the relational key for those tables.
  emailPreferences: many(emailPreferences),
  userEvents: many(userEvents),
  journeyStates: many(journeyStates),
  bucketMemberships: many(bucketMemberships),
  // contact_aliases joins on the contacts.id UUID (real FK).
  aliases: many(contactAliases),
}));

export const contactAliasesRelations = relations(contactAliases, ({ one }) => ({
  contact: one(contacts, {
    fields: [contactAliases.contactId],
    references: [contacts.id],
  }),
}));

export const bucketMembershipsRelations = relations(
  bucketMemberships,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [bucketMemberships.userId],
      references: [contacts.externalId],
    }),
  }),
);

export const emailPreferencesRelations = relations(
  emailPreferences,
  ({ one }) => ({
    contact: one(contacts, {
      fields: [emailPreferences.userId],
      references: [contacts.externalId],
    }),
  }),
);

export const userEventsRelations = relations(userEvents, ({ one }) => ({
  contact: one(contacts, {
    fields: [userEvents.userId],
    references: [contacts.externalId],
  }),
}));

export const journeyStatesRelations = relations(
  journeyStates,
  ({ one, many }) => ({
    contact: one(contacts, {
      fields: [journeyStates.userId],
      references: [contacts.externalId],
    }),
    logs: many(journeyLogs),
    emailSends: many(emailSends),
    smsSends: many(smsSends),
  }),
);

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

export const smsSendsRelations = relations(smsSends, ({ one, many }) => ({
  journeyState: one(journeyStates, {
    fields: [smsSends.journeyStateId],
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
    smsSend: one(smsSends, {
      fields: [trackedLinks.smsSendId],
      references: [smsSends.id],
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

export const webhookEndpointsRelations = relations(
  webhookEndpoints,
  ({ many }) => ({
    deliveries: many(webhookDeliveries),
  }),
);

export const webhookDeliveriesRelations = relations(
  webhookDeliveries,
  ({ one }) => ({
    endpoint: one(webhookEndpoints, {
      fields: [webhookDeliveries.endpointId],
      references: [webhookEndpoints.id],
    }),
  }),
);

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
