import { emailPreferences } from "@hogsend/db";
import type { UnsubscribeTokenPayload } from "@hogsend/email";
import {
  generateUnsubscribeToken,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { htmlPage } from "../../lib/html.js";
import { getListRegistry } from "../../lists/registry-singleton.js";

// The built-in journey/lifecycle category is always shown. Defined lists (D3)
// are appended from the registry so the preference center and the mailer's
// suppression check share ONE polarity source (`ListRegistry.isSubscribed`).
const BUILTIN_CATEGORIES = [
  { id: "journey", label: "Journey & lifecycle emails" },
] as const;

const preferencesRoute = createRoute({
  method: "get",
  path: "/preferences",
  tags: ["Email"],
  summary: "Email preference center",
  request: {
    query: z.object({
      token: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: { "text/html": { schema: z.string() } },
      description: "Preference center page",
    },
    400: {
      content: { "text/html": { schema: z.string() } },
      description: "Invalid or expired token",
    },
  },
});

export const preferencesRouter = new OpenAPIHono<AppEnv>().openapi(
  preferencesRoute,
  async (c) => {
    const { token } = c.req.valid("query");
    const { env, db } = c.get("container");

    let payload: UnsubscribeTokenPayload;
    try {
      payload = validateUnsubscribeToken({
        token,
        secret: env.BETTER_AUTH_SECRET,
      });
    } catch (err) {
      const message =
        err instanceof InvalidTokenError ? err.message : "Invalid token";
      return c.html(
        htmlPage({
          title: "Invalid Link",
          body: `<h1>This link is no longer valid</h1><p>${message}. Please check your email for a newer link.</p>`,
        }),
        400,
      );
    }

    const { externalId, email } = payload;

    const rows = await db
      .select()
      .from(emailPreferences)
      .where(
        and(
          eq(emailPreferences.userId, externalId),
          eq(emailPreferences.email, email),
        ),
      )
      .limit(1);

    const prefs = rows[0];
    const categories = (prefs?.categories ?? {}) as Record<string, boolean>;
    const globalUnsub = prefs?.unsubscribedAll ?? false;

    function makeActionUrl(
      action: "unsubscribe" | "resubscribe",
      category?: string,
    ): string {
      const actionToken = generateUnsubscribeToken({
        secret: env.BETTER_AUTH_SECRET,
        externalId,
        email,
        action,
        category,
      });
      return `${env.API_PUBLIC_URL}/v1/email/unsubscribe?token=${encodeURIComponent(actionToken)}`;
    }

    // Partition the enabled registry lists into engine-synthesized CHANNELS and
    // author-defined TOPICS (`meta.kind ?? "topic"` mirrors every read site).
    // The built-in journey category is always a topic and leads that group.
    // Deduped by id across both groups (a list MAY NOT reuse a reserved category
    // id, but guard anyway).
    const listRegistry = getListRegistry();
    const seen = new Set<string>();
    const channelCategories: { id: string; label: string }[] = [];
    const topicCategories: { id: string; label: string }[] = [];

    // Single pass: channels are collected in registry order (deduped now);
    // non-channels are buffered and appended AFTER the built-ins. Because every
    // channel id lands in `seen` before any buffered topic is deduped, this is
    // identical to the prior two-pass form (channel pass fully preceding the
    // topic pass, with the built-ins seeded in between).
    const bufferedTopics: { id: string; label: string }[] = [];
    for (const list of listRegistry.getEnabled()) {
      if ((list.kind ?? "topic") === "channel") {
        if (seen.has(list.id)) continue;
        seen.add(list.id);
        channelCategories.push({ id: list.id, label: list.name });
      } else {
        bufferedTopics.push({ id: list.id, label: list.name });
      }
    }

    for (const cat of BUILTIN_CATEGORIES) {
      seen.add(cat.id);
      topicCategories.push({ id: cat.id, label: cat.label });
    }
    for (const topic of bufferedTopics) {
      if (seen.has(topic.id)) continue;
      seen.add(topic.id);
      topicCategories.push(topic);
    }

    function renderRow(cat: { id: string; label: string }): string {
      // Registry-driven polarity (§2.6): defined lists/channels honour their
      // `defaultOptIn`; unknown ids (e.g. the built-in `journey`) fall through
      // to opt-in default (blocked only on explicit `false`). A global
      // unsubscribe overrides every per-category state. Flat channel ids pass
      // the unsubscribe route's category pattern, so channel rows reuse the same
      // per-category token action links unchanged.
      const isSubscribed =
        listRegistry.isSubscribed(categories, cat.id) && !globalUnsub;
      const statusClass = isSubscribed ? "subscribed" : "unsubscribed";
      const statusText = isSubscribed ? "Subscribed" : "Unsubscribed";
      const actionLabel = isSubscribed ? "Unsubscribe" : "Resubscribe";
      const actionUrl = isSubscribed
        ? makeActionUrl("unsubscribe", cat.id)
        : makeActionUrl("resubscribe", cat.id);

      return `
        <div class="pref-row">
          <div>
            <div class="pref-label">${cat.label}</div>
            <div class="pref-status ${statusClass}">${statusText}</div>
          </div>
          <a href="${actionUrl}">${actionLabel}</a>
        </div>`;
    }

    // Section headings render ONLY when channels exist. On a channel-less engine
    // BOTH headings are suppressed so the page is byte-identical to the
    // pre-channels layout (bare topic rows, no headings). When channels exist we
    // show `Channels` then `Email topics`.
    const hasChannels = channelCategories.length > 0;
    let categoryRows = "";
    if (hasChannels) {
      categoryRows += `<h2 class="pref-section">Channels</h2>`;
      categoryRows += channelCategories.map(renderRow).join("");
    }
    if (hasChannels && topicCategories.length > 0) {
      categoryRows += `<h2 class="pref-section">Email topics</h2>`;
    }
    categoryRows += topicCategories.map(renderRow).join("");

    const globalStatusClass = globalUnsub ? "unsubscribed" : "subscribed";
    const globalStatusText = globalUnsub
      ? "Unsubscribed from all"
      : "Receiving emails";
    const globalActionLabel = globalUnsub
      ? "Resubscribe to all"
      : "Unsubscribe from all";
    const globalActionUrl = globalUnsub
      ? makeActionUrl("resubscribe")
      : makeActionUrl("unsubscribe");

    return c.html(
      htmlPage({
        title: "Email Preferences",
        body: `<h1>Email Preferences</h1>
        <p>Manage which emails you receive at <strong>${email}</strong>.</p>
        ${categoryRows}
        <div class="global-row">
          <div class="pref-row" style="border-bottom: none;">
            <div>
              <div class="pref-label">All emails</div>
              <div class="pref-status ${globalStatusClass}">${globalStatusText}</div>
            </div>
            <a href="${globalActionUrl}">${globalActionLabel}</a>
          </div>
        </div>`,
      }),
      200,
    );
  },
);
