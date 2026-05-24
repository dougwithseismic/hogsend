import type { Duration } from "@hatchet-dev/typescript-sdk/v1/client/duration.js";
import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { evaluateCondition } from "@hogsend/core";
import type {
  EmailEngagementCondition,
  JourneyContext,
  JourneyUser,
  PropertyCondition,
  SendEmailOptions,
} from "@hogsend/core/types";
import { type Database, journeyStates, userEvents } from "@hogsend/db";
import { JourneyNotificationEmail, renderToHtml } from "@hogsend/email";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import type { sendEmailTask as SendEmailTaskType } from "../workflows/send-email.js";

interface JourneyContextConfig {
  db: Database;
  hatchet: HatchetClient;
  hatchetCtx: { sleepFor: (duration: Duration) => Promise<unknown> };
  sendEmailTask: typeof SendEmailTaskType;
  stateId: string;
  journeyId: string;
  journeyName: string;
  userId: string;
  journeyContext: Record<string, unknown>;
}

export function createJourneyContext(
  config: JourneyContextConfig,
): JourneyContext {
  const {
    db,
    hatchet,
    hatchetCtx,
    sendEmailTask,
    stateId,
    journeyId,
    journeyName,
    userId,
    journeyContext,
  } = config;

  async function updateCheckpoint(label: string): Promise<void> {
    await db
      .update(journeyStates)
      .set({ currentNodeId: label, updatedAt: new Date() })
      .where(eq(journeyStates.id, stateId));
  }

  return {
    async sendEmail(
      user: JourneyUser,
      options: SendEmailOptions,
    ): Promise<{ emailId: string }> {
      await updateCheckpoint(`email:${options.template}`);

      const element = createElement(JourneyNotificationEmail, {
        name:
          (options.props?.firstName as string) ??
          (options.props?.name as string) ??
          user.email.split("@")[0] ??
          "there",
        journeyName,
        eventName: options.template,
        body: options.subject,
      });
      const html = await renderToHtml(element);

      const result = await sendEmailTask.run({
        to: user.email,
        subject: options.subject,
        html,
        tags: [
          { name: "journeyId", value: journeyId },
          { name: "templateKey", value: options.template },
          { name: "userId", value: user.id },
        ],
      });

      await hatchet.events.push("journey:email.sent", {
        journeyId,
        stateId,
        userId: user.id,
        templateKey: options.template,
        emailId: result.emailId,
      });

      return { emailId: result.emailId };
    },

    async hasEvent(
      targetUserId: string,
      eventName: string,
      opts?: { withinHours?: number },
    ): Promise<boolean> {
      return evaluateCondition(
        {
          type: "event",
          eventName,
          check: "exists",
          withinHours: opts?.withinHours,
        },
        { db, userId: targetUserId, journeyContext },
      );
    },

    async checkProperty(
      source: PropertyCondition["source"],
      property: string,
      operator: PropertyCondition["operator"],
      value?: PropertyCondition["value"],
    ): Promise<boolean> {
      return evaluateCondition(
        { type: "property", source, property, operator, value },
        { db, userId, journeyContext },
      );
    },

    async checkEmailEngagement(
      templateKey: string,
      check: EmailEngagementCondition["check"],
    ): Promise<boolean> {
      return evaluateCondition(
        { type: "email_engagement", templateKey, check },
        { db, userId, journeyContext },
      );
    },

    async fireEvent(
      targetUserId: string,
      eventName: string,
      properties?: Record<string, unknown>,
    ): Promise<void> {
      await updateCheckpoint(`event:${eventName}`);

      await db.insert(userEvents).values({
        userId: targetUserId,
        event: eventName,
        properties: properties ?? {},
      });

      await hatchet.events.push(`user:${eventName}`, {
        userId: targetUserId,
        journeyId,
        properties: properties ?? {},
      });
    },

    async webhook(
      url: string,
      opts?: {
        method?: "POST" | "PUT";
        headers?: Record<string, string>;
        body?: Record<string, unknown>;
      },
    ): Promise<void> {
      await updateCheckpoint(`webhook:${url}`);

      const method = opts?.method ?? "POST";
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(opts?.headers ?? {}),
        },
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
      });

      if (!response.ok) {
        throw new Error(
          `Webhook ${method} ${url} failed: ${response.status} ${response.statusText}`,
        );
      }
    },

    async enrollJourney(
      targetUserId: string,
      targetUserEmail: string,
      targetJourneyId: string,
    ): Promise<void> {
      await updateCheckpoint(`enroll:${targetJourneyId}`);

      await hatchet.events.push("journey:enroll", {
        userId: targetUserId,
        userEmail: targetUserEmail,
        targetJourneyId,
        sourceJourneyId: journeyId,
      });
    },

    async sleepFor(duration: string, label?: string): Promise<void> {
      await db
        .update(journeyStates)
        .set({
          status: "waiting",
          currentNodeId: label ?? `wait:${duration}`,
          updatedAt: new Date(),
        })
        .where(eq(journeyStates.id, stateId));

      await hatchetCtx.sleepFor(duration as Duration);

      await db
        .update(journeyStates)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(journeyStates.id, stateId));
    },

    async checkpoint(label: string): Promise<void> {
      await updateCheckpoint(label);
    },
  };
}
