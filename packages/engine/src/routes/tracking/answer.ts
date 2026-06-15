import { trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { htmlPage } from "../../lib/html.js";
import {
  pushTrackingEvent,
  resolveEmailSendContext,
} from "../../lib/tracking-events.js";

/**
 * The hosted answer page — the engine-served landing for a semantic link
 * whose author has no page of their own (`href={HOSTED_ANSWER_HREF}` in
 * `EmailAction`). Possession of the unguessable link id is the auth, the
 * same trust model as unsubscribe.
 *
 * GET shows the recorded answer and an optional free-text box; POST ingests
 * the comment as `<event>.comment` — a real consumer event journeys and
 * destinations can react to. ONE comment per (send, event): the
 * `semc:` idempotency key mirrors first-answer-wins, which also caps what a
 * forwarded link can inject.
 */

const COMMENT_MAX = 2000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function describeAnswer(properties: Record<string, unknown> | null): string {
  if (!properties) return "";
  const parts = Object.entries(properties)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`);
  return parts.join(" · ");
}

async function loadSemanticLink(
  db: AppEnv["Variables"]["container"]["db"],
  id: string,
) {
  const rows = await db
    .select({
      id: trackedLinks.id,
      emailSendId: trackedLinks.emailSendId,
      event: trackedLinks.event,
      eventProperties: trackedLinks.eventProperties,
    })
    .from(trackedLinks)
    .where(eq(trackedLinks.id, id))
    .limit(1);
  const link = rows[0];
  return link?.event ? link : null;
}

const answerPageRoute = createRoute({
  method: "get",
  path: "/a/:id",
  tags: ["Tracking"],
  summary: "Hosted answer page for a semantic link",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Answer page",
      content: { "text/html": { schema: z.string() } },
    },
    404: { description: "Not a semantic link" },
  },
});

const answerCommentRoute = createRoute({
  method: "post",
  path: "/a/:id",
  tags: ["Tracking"],
  summary: "Attach a free-text comment to a semantic answer",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/x-www-form-urlencoded": {
          schema: z.object({ comment: z.string().min(1).max(COMMENT_MAX) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Comment recorded",
      content: { "text/html": { schema: z.string() } },
    },
    404: { description: "Not a semantic link" },
  },
});

export const answerRouter = new OpenAPIHono<AppEnv>()
  .openapi(answerPageRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { db } = c.get("container");

    const link = await loadSemanticLink(db, id);
    if (!link) {
      return c.html(
        htmlPage({
          title: "Not found",
          body: "<h1>Nothing here</h1><p>This link doesn't lead anywhere.</p>",
        }),
        404,
      );
    }

    const answer = describeAnswer(link.eventProperties);
    return c.html(
      htmlPage({
        title: "Thanks — answer recorded",
        body: `
  <h1>Thanks — that's recorded.</h1>
  ${answer ? `<p>Your answer: <strong>${answer}</strong></p>` : ""}
  <p>Anything you'd like to add? A sentence here goes straight to the team.</p>
  <form method="post" action="">
    <textarea name="comment" rows="4" maxlength="${COMMENT_MAX}" required
      style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:8px;font:inherit"></textarea>
    <button type="submit"
      style="margin-top:12px;padding:10px 18px;border:0;border-radius:8px;background:#1a1a1a;color:#fff;font:inherit;cursor:pointer">
      Send
    </button>
  </form>`,
      }),
    );
  })
  .openapi(answerCommentRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { comment } = c.req.valid("form");
    const { db, hatchet, registry, logger } = c.get("container");

    const link = await loadSemanticLink(db, id);
    if (!link) {
      return c.html(
        htmlPage({
          title: "Not found",
          body: "<h1>Nothing here</h1><p>This link doesn't lead anywhere.</p>",
        }),
        404,
      );
    }

    // The answer/comment flow is EMAIL-semantic (it re-ingests a
    // `<event>.comment` keyed on the send). A non-email semantic link has no
    // send to attribute the comment to — `emailSendId` is nullable since the
    // identity-stitching minor, so narrow it here.
    const emailSendId = link.emailSendId;
    const ctx = emailSendId
      ? await resolveEmailSendContext(db, emailSendId)
      : null;
    if (ctx && emailSendId) {
      // `<event>.comment` is a consumer-namespace event — journeys can wait
      // on it and destinations receive it like any other. First comment per
      // (send, event) wins; repeats are no-ops.
      await pushTrackingEvent({
        db,
        hatchet,
        registry,
        logger,
        event: `${link.event}.comment`,
        emailSendId,
        properties: {
          comment,
          parentEvent: link.event,
          ...(link.eventProperties ?? {}),
          linkId: link.id,
        },
        resolvedContext: ctx,
        idempotencyKey: `semc:${emailSendId}:${link.event}`,
      }).catch((err) => {
        logger.warn("Failed to ingest answer comment", {
          linkId: link.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return c.html(
      htmlPage({
        title: "Thank you",
        body: "<h1>Thank you.</h1><p>Your note is on its way to the team. You can close this tab.</p>",
      }),
    );
  });
