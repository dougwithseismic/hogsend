import { evaluateCondition } from "@hogsend/core";
import type { JourneyNode } from "@hogsend/core/types";
import { createDatabase, journeyStates, userEvents } from "@hogsend/db";
import { JourneyNotificationEmail, renderToHtml } from "@hogsend/email";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { createJourneyRegistry } from "../journeys/index.js";
import { hatchet } from "../lib/hatchet.js";
import { sendEmailTask } from "./send-email.js";

const { db } = createDatabase(process.env.DATABASE_URL ?? "");
const registry = createJourneyRegistry(process.env.ENABLED_JOURNEYS);

const MAX_NODES = 50;

type RunJourneyInput = {
  stateId: string;
  journeyId: string;
  userId: string;
  userEmail: string;
  context: Record<string, string | number | boolean | null>;
};

export const runJourneyTask = hatchet.durableTask({
  name: "run-journey",
  executionTimeout: "720h",
  retries: 0,
  fn: async (input: RunJourneyInput, ctx) => {
    const { stateId, userId, userEmail } = input;
    const journeyContext = { ...input.context };
    const journeyDefinition = registry.get(input.journeyId);

    if (!journeyDefinition) {
      await markFailed(stateId, `Journey not found: ${input.journeyId}`);
      throw new Error(`Journey not found: ${input.journeyId}`);
    }

    let currentNodeId: string | null = journeyDefinition.entryNode;
    let nodesProcessed = 0;

    try {
      while (currentNodeId && nodesProcessed < MAX_NODES) {
        const node = journeyDefinition.nodes[currentNodeId] as
          | JourneyNode
          | undefined;
        if (!node) break;

        await db
          .update(journeyStates)
          .set({ currentNodeId, updatedAt: new Date() })
          .where(eq(journeyStates.id, stateId));

        switch (node.type) {
          case "action":
            await executeAction(node, {
              userId,
              userEmail,
              stateId,
              journeyId: input.journeyId,
              journeyName: journeyDefinition.name,
            });
            currentNodeId = node.next;
            break;

          case "wait":
            await db
              .update(journeyStates)
              .set({ status: "waiting", updatedAt: new Date() })
              .where(eq(journeyStates.id, stateId));

            await ctx.sleepFor(`${node.hours}h`);

            await db
              .update(journeyStates)
              .set({ status: "active", updatedAt: new Date() })
              .where(eq(journeyStates.id, stateId));

            currentNodeId = node.next;
            break;

          case "condition": {
            const result = await evaluateCondition(node.eval, {
              db,
              userId,
              journeyContext,
            });
            currentNodeId = result ? node.onTrue : node.onFalse;
            break;
          }
        }

        nodesProcessed++;
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error during journey";
      await markFailed(stateId, message, currentNodeId);

      await hatchet.events.push("journey:failed", {
        journeyId: input.journeyId,
        stateId,
        userId,
        error: message,
      });

      throw err;
    }

    await db
      .update(journeyStates)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(journeyStates.id, stateId));

    await hatchet.events.push("journey:completed", {
      journeyId: input.journeyId,
      stateId,
      userId,
    });

    return { stateId, status: "completed", nodesProcessed };
  },
});

async function markFailed(
  stateId: string,
  errorMessage: string,
  nodeId?: string | null,
) {
  await db
    .update(journeyStates)
    .set({
      status: "failed",
      errorMessage,
      ...(nodeId ? { currentNodeId: nodeId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(journeyStates.id, stateId));
}

interface ActionContext {
  userId: string;
  userEmail: string;
  stateId: string;
  journeyId: string;
  journeyName: string;
}

async function executeAction(
  node: Extract<JourneyNode, { type: "action" }>,
  ctx: ActionContext,
): Promise<void> {
  const { action } = node;

  switch (action.type) {
    case "send_email": {
      const element = createElement(JourneyNotificationEmail, {
        name: ctx.userEmail.split("@")[0] ?? "there",
        journeyName: ctx.journeyName,
        eventName: action.templateKey,
        body: action.subject,
      });
      const html = await renderToHtml(element);

      const result = await sendEmailTask.run({
        to: ctx.userEmail,
        subject: action.subject,
        html,
        tags: [
          { name: "journeyId", value: ctx.journeyId },
          { name: "templateKey", value: action.templateKey },
          { name: "userId", value: ctx.userId },
        ],
      });

      await hatchet.events.push("journey:email.sent", {
        journeyId: ctx.journeyId,
        stateId: ctx.stateId,
        userId: ctx.userId,
        templateKey: action.templateKey,
        emailId: result.emailId,
      });
      break;
    }

    case "fire_event":
      await db.insert(userEvents).values({
        userId: ctx.userId,
        event: action.eventName,
        properties: action.properties ?? {},
      });

      await hatchet.events.push(`user:${action.eventName}`, {
        userId: ctx.userId,
        journeyId: ctx.journeyId,
        properties: action.properties ?? {},
      });
      break;

    case "webhook": {
      const method = action.method ?? "POST";
      await fetch(action.url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(action.headers ?? {}),
        },
        body: action.body ? JSON.stringify(action.body) : undefined,
      });
      break;
    }

    case "enroll_journey":
      await hatchet.events.push("journey:enroll", {
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        targetJourneyId: action.journeyId,
        sourceJourneyId: ctx.journeyId,
      });
      break;
  }
}
