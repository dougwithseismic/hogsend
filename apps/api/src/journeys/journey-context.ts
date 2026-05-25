import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { DurationObject } from "@hogsend/core";
import { evaluateCondition } from "@hogsend/core";
import type {
  JourneyContext,
  JourneyUser,
  SendEmailOptions,
} from "@hogsend/core/types";
import { type Database, journeyStates, userEvents } from "@hogsend/db";
import {
  generateUnsubscribeUrl,
  JourneyNotificationEmail,
  renderToHtml,
} from "@hogsend/email";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import type { sendEmailTask as SendEmailTaskType } from "../workflows/send-email.js";

interface UnsubscribeConfig {
  baseUrl: string;
  secret: string;
}

interface JourneyContextConfig {
  db: Database;
  hatchet: HatchetClient;
  hatchetCtx: { sleepFor: (duration: DurationObject) => Promise<unknown> };
  sendEmailTask: typeof SendEmailTaskType;
  stateId: string;
  journeyId: string;
  journeyName: string;
  userId: string;
  userEmail: string;
  journeyContext: Record<string, unknown>;
  unsubscribeConfig?: UnsubscribeConfig;
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
    unsubscribeConfig,
  } = config;

  async function updateCheckpoint(label: string): Promise<void> {
    await db
      .update(journeyStates)
      .set({ currentNodeId: label, updatedAt: new Date() })
      .where(eq(journeyStates.id, stateId));
  }

  return {
    async sleep({ duration, label }) {
      const sleptAt = new Date().toISOString();

      await db
        .update(journeyStates)
        .set({
          status: "waiting",
          currentNodeId: label ?? `wait:${JSON.stringify(duration)}`,
          updatedAt: new Date(),
        })
        .where(eq(journeyStates.id, stateId));

      await hatchetCtx.sleepFor(duration);

      const resumedAt = new Date().toISOString();

      await db
        .update(journeyStates)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(journeyStates.id, stateId));

      return { sleptAt, resumedAt };
    },

    async checkpoint(label) {
      await updateCheckpoint(label);
    },

    event: {
      async check({ userId: targetUserId, event, withinHours }) {
        const found = await evaluateCondition(
          {
            type: "event",
            eventName: event,
            check: "exists",
            withinHours,
          },
          { db, userId: targetUserId, journeyContext },
        );
        return { found, count: found ? 1 : 0 };
      },

      async fire({ userId: targetUserId, event, properties = {} }) {
        await updateCheckpoint(`event:${event}`);

        await db.insert(userEvents).values({
          userId: targetUserId,
          event,
          properties,
        });

        const eventKey = `user:${event}`;
        await hatchet.events.push(eventKey, {
          userId: targetUserId,
          journeyId,
          properties,
        });

        return { eventKey, firedAt: new Date().toISOString() };
      },
    },

    email: {
      async send(user: JourneyUser, options: SendEmailOptions) {
        await updateCheckpoint(`email:${options.template}`);

        let unsubscribeUrl: string | undefined;
        if (unsubscribeConfig) {
          unsubscribeUrl = generateUnsubscribeUrl({
            baseUrl: unsubscribeConfig.baseUrl,
            secret: unsubscribeConfig.secret,
            externalId: user.id,
            email: user.email,
          });
        }

        const element = createElement(JourneyNotificationEmail, {
          name:
            (options.props?.firstName as string) ??
            (options.props?.name as string) ??
            user.email.split("@")[0] ??
            "there",
          journeyName,
          eventName: options.template,
          body: options.subject,
          unsubscribeUrl,
        });
        const html = await renderToHtml(element);

        const headers: Record<string, string> = {};
        if (unsubscribeUrl) {
          headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
          headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
        }

        const result = await sendEmailTask.run({
          to: user.email,
          subject: options.subject,
          html,
          tags: [
            { name: "journeyId", value: journeyId },
            { name: "templateKey", value: options.template },
            { name: "userId", value: user.id },
          ],
          headers,
        });

        await hatchet.events.push("journey:email.sent", {
          journeyId,
          stateId,
          userId: user.id,
          templateKey: options.template,
          emailId: result.emailId,
        });

        return { emailId: result.emailId, sentAt: new Date().toISOString() };
      },

      async checkEngagement({ templateKey, check }) {
        const matched = await evaluateCondition(
          { type: "email_engagement", templateKey, check },
          { db, userId, journeyContext },
        );
        return { matched, check };
      },
    },

    property: {
      async check({ source, property, operator, value }) {
        const matched = await evaluateCondition(
          { type: "property", source, property, operator, value },
          { db, userId, journeyContext },
        );

        let actualValue: unknown;
        if (source === "context") {
          actualValue = journeyContext[property];
        }

        return { matched, actualValue };
      },
    },

    webhook: {
      async send({ url, method: httpMethod, headers: reqHeaders, body }) {
        await updateCheckpoint(`webhook:${url}`);

        const method = httpMethod ?? "POST";
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(reqHeaders ?? {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
          throw new Error(
            `Webhook ${method} ${url} failed: ${response.status} ${response.statusText}`,
          );
        }

        return { statusCode: response.status };
      },
    },

    journey: {
      async enroll({
        userId: targetUserId,
        userEmail: targetUserEmail,
        journeyId: targetJourneyId,
      }) {
        await updateCheckpoint(`enroll:${targetJourneyId}`);

        await hatchet.events.push("journey:enroll", {
          userId: targetUserId,
          userEmail: targetUserEmail,
          targetJourneyId,
          sourceJourneyId: journeyId,
        });

        return { enrolledAt: new Date().toISOString() };
      },
    },
  };
}
