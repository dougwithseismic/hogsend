import { auditLogs, campaigns } from "@hogsend/db";
import { getTemplateNames } from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { agentConfig } from "../../lib/agent/config.js";
import {
  InvalidProposalError,
  type VerifiedProposal,
  verifyAndBurnProposal,
} from "../../lib/agent/proposals.js";
import { getAgentModel } from "../../lib/agent/provider.js";
import { effectiveTier } from "../../lib/agent/risk.js";
import { buildAgentSystemPrompt } from "../../lib/agent/system-prompt.js";
import { buildAgentTools } from "../../lib/agent/tools.js";
import {
  resolveContact,
  resolveOrCreateContact,
  softDeleteContact,
} from "../../lib/contacts.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { applyListMembership } from "../../lib/preferences.js";
import { sendCampaignTask } from "../../workflows/send-campaign.js";

const configRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Admin — Agent"],
  summary: "Studio co-working agent availability + active model",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            enabled: z
              .boolean()
              .describe(
                "true only when AGENT_ENABLED and an OpenRouter key are set",
              ),
            model: z
              .string()
              .describe("the OpenRouter model id the agent runs on"),
          }),
        },
      },
      description: "Whether the agent is configured, and which model it uses",
    },
  },
});

export const agentRouter = new OpenAPIHono<AppEnv>();

agentRouter.openapi(configRoute, (c) => {
  const { env } = c.get("container");
  const cfg = agentConfig(env);
  return c.json({ enabled: cfg.enabled, model: cfg.model }, 200);
});

/**
 * Streaming chat. NOT an `.openapi()` route — `@hono/zod-openapi` can't model a
 * non-JSON UI-message stream body — so it's a plain POST that returns the AI
 * SDK's stream Response directly. Mounted under `adminRouter`, so it already
 * inherits requireAdmin + rateLimit + auditMiddleware. The browser sends the
 * Better Auth session cookie; the OpenRouter key never leaves the server.
 */
agentRouter.post("/chat", async (c) => {
  const container = c.get("container");
  const cfg = agentConfig(container.env);
  if (!cfg.enabled) {
    return c.json({ error: "agent_unconfigured" }, 503);
  }

  const body = await c.req.json<{ messages?: UIMessage[] }>();
  const messages = body.messages ?? [];

  // The proposing operator — stamped into every minted write proposal so the
  // confirm route can bind execution to the same actor.
  const user = c.get("user") as { email?: string } | null;
  const apiKey = c.get("apiKey") as { name?: string } | undefined;
  const actorEmail = user?.email ?? apiKey?.name ?? "agent";

  const result = streamText({
    model: getAgentModel(container.env),
    system: await buildAgentSystemPrompt(container),
    messages: await convertToModelMessages(messages),
    tools: buildAgentTools({ container, actorEmail }),
    stopWhen: stepCountIs(container.env.AGENT_MAX_STEPS),
  });

  return result.toUIMessageStreamResponse();
});

/**
 * The HITL chokepoint — the ONLY place an agent write executes. A write tool's
 * `execute` merely mints a single-use proposal token; the operator clicks
 * confirm in Studio and the browser POSTs `{ token }` here. We verify+burn the
 * token (single-use, 10-min TTL), assert the confirming actor matches the
 * minting actor, re-derive the tier from CURRENT test-mode, dispatch to the real
 * backing fn (idempotency-key = proposalId), and write an explicit audit row.
 */
agentRouter.post("/confirm", async (c) => {
  const container = c.get("container");
  const {
    db,
    env,
    registry,
    hatchet,
    logger,
    emailService,
    domainStatus,
    analytics,
    templates,
  } = container;

  if (!agentConfig(env).enabled) {
    return c.json({ error: "agent_unconfigured" }, 503);
  }

  const user = c.get("user") as { email?: string } | null;
  const apiKey = c.get("apiKey") as { name?: string } | undefined;
  const actor = user?.email ?? apiKey?.name ?? "unknown";

  const { token } = await c.req.json<{ token?: string }>();
  if (!token) return c.json({ error: "token required" }, 400);

  let proposal: VerifiedProposal;
  try {
    proposal = await verifyAndBurnProposal({
      token,
      secret: env.BETTER_AUTH_SECRET,
    });
  } catch (err) {
    if (err instanceof InvalidProposalError) {
      return c.json({ error: err.message }, 410);
    }
    throw err;
  }

  if (proposal.actorEmail !== actor) {
    return c.json({ error: "Proposal actor mismatch" }, 403);
  }

  const tier = effectiveTier(proposal.tool, {
    testMode: domainStatus.testModeCached(),
  });

  const args = proposal.args;
  const idem = proposal.proposalId;
  let result: unknown;

  try {
    switch (proposal.tool) {
      case "fire_event":
        result = await ingestEvent({
          db,
          registry,
          hatchet,
          logger,
          analytics,
          event: {
            event: String(args.event),
            userId: args.userId as string | undefined,
            userEmail: args.userEmail as string | undefined,
            eventProperties: (args.eventProperties ?? {}) as Record<
              string,
              unknown
            >,
            idempotencyKey: idem,
            source: "agent",
          },
        });
        break;

      case "enroll_in_journey": {
        const meta = registry.get(String(args.journeyId));
        if (!meta) return c.json({ error: "Journey not found" }, 404);
        result = await ingestEvent({
          db,
          registry,
          hatchet,
          logger,
          analytics,
          event: {
            event: meta.trigger.event,
            userId: args.userId as string | undefined,
            userEmail: args.userEmail as string | undefined,
            eventProperties: (args.properties ?? {}) as Record<string, unknown>,
            idempotencyKey: idem,
            source: "agent",
          },
        });
        break;
      }

      case "send_transactional_email": {
        if (!getTemplateNames(templates).includes(args.template as never)) {
          return c.json({ error: `Unknown template: ${args.template}` }, 400);
        }
        result = await emailService.send({
          template: args.template as never,
          props: (args.props ?? {}) as never,
          to: String(args.to),
          subject: args.subject as string | undefined,
          userId: args.userId as string | undefined,
          idempotencyKey: idem,
        });
        break;
      }

      case "send_campaign": {
        if (!getTemplateNames(templates).includes(args.template as never)) {
          return c.json({ error: `Unknown template: ${args.template}` }, 400);
        }
        const audienceKind = args.list ? "list" : "bucket";
        const audienceId = String(args.list ?? args.bucket);
        const inserted = await db
          .insert(campaigns)
          .values({
            name:
              (args.name as string) ??
              `Agent campaign to ${audienceKind} ${audienceId}`,
            status: "queued",
            audienceKind,
            audienceId,
            templateKey: String(args.template) as never,
            props: (args.props ?? {}) as Record<string, unknown>,
            fromEmail: (args.from as string) ?? null,
            subject: (args.subject as string) ?? null,
            idempotencyKey: idem,
          })
          .onConflictDoNothing({ target: campaigns.idempotencyKey })
          .returning({ id: campaigns.id });
        const campaignId =
          inserted[0]?.id ??
          (
            await db
              .select({ id: campaigns.id })
              .from(campaigns)
              .where(eq(campaigns.idempotencyKey, idem))
              .limit(1)
          )[0]?.id;
        if (!campaignId) throw new Error("Failed to create campaign");
        await sendCampaignTask.run({ campaignId });
        result = { campaignId, status: "queued" };
        break;
      }

      case "subscribe_list":
      case "unsubscribe_list": {
        const subscribed = proposal.tool === "subscribe_list";
        await resolveOrCreateContact({
          db,
          userId: args.userId as string | undefined,
          email: args.email as string | undefined,
        });
        await applyListMembership({
          db,
          userId: args.userId as string | undefined,
          email: args.email as string | undefined,
          lists: { [String(args.list)]: subscribed },
        });
        result = { list: String(args.list), subscribed };
        break;
      }

      case "upsert_contact":
        result = await resolveOrCreateContact({
          db,
          userId: args.userId as string | undefined,
          email: args.email as string | undefined,
          anonymousId: args.anonymousId as string | undefined,
          contactProperties: (args.properties ?? {}) as Record<string, unknown>,
        });
        break;

      case "update_contact": {
        const current = await resolveContact({ db, id: String(args.id) });
        if (!current) return c.json({ error: "Contact not found" }, 404);
        result = await resolveOrCreateContact({
          db,
          userId: current.externalId ?? undefined,
          email: (args.email as string) ?? current.email ?? undefined,
          contactProperties: (args.properties ?? {}) as Record<string, unknown>,
        });
        break;
      }

      case "delete_contact":
        result = await softDeleteContact({
          db,
          email: args.email as string | undefined,
          userId: args.userId as string | undefined,
        });
        break;

      default:
        return c.json({ error: `Unknown tool: ${proposal.tool}` }, 400);
    }
  } catch (err) {
    logger.warn("agent confirm: write failed", {
      tool: proposal.tool,
      proposalId: proposal.proposalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }

  // Explicit audit row (carries args/result/tier the generic middleware can't).
  db.insert(auditLogs)
    .values({
      actor: `agent:${actor}`,
      action: `agent.confirm.${proposal.tool}`,
      resource: "agent",
      resourceId: proposal.proposalId,
      detail: {
        tool: proposal.tool,
        tier,
        baseTier: proposal.tier,
        sessionId: proposal.sessionId,
        args,
        result,
      },
      ipAddress:
        c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    })
    .then(() => {})
    .catch((e: unknown) =>
      logger.warn("agent confirm audit write failed", {
        error: e instanceof Error ? e.message : String(e),
      }),
    );

  return c.json({ ok: true, result }, 200);
});
