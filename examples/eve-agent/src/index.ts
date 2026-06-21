/**
 * Eve Agent — minimal retention-strategist service
 *
 * This is a standalone Node >=24 service that acts as a minimal "Eve platform"
 * for local development and integration testing of the Hogsend Tier-3
 * ai-churn-save journey.
 *
 * What it does:
 *  1. Exposes POST /eve/v1/session — the endpoint Hogsend calls via
 *     `startEveSession()`. Accepts a session start request and immediately
 *     kicks off the agent loop in the background.
 *  2. The agent loop is intentionally simple: it sleeps briefly (simulating
 *     HITL review latency) then calls back to Hogsend at
 *     POST /v1/webhooks/eve with the shared secret in `x-eve-signature`.
 *
 * Required env vars:
 *   PORT                  — HTTP port for this service (default: 3099)
 *   EVE_WEBHOOK_SECRET    — shared secret (must match Hogsend's EVE_WEBHOOK_SECRET)
 *   HOGSEND_API_URL       — base URL of the Hogsend API (default: http://localhost:3002)
 *   HOGSEND_CALLBACK_URL  — override for the callback URL (optional; defaults to
 *                           HOGSEND_API_URL + /v1/webhooks/eve)
 *   HITL_DELAY_MS         — simulated HITL review delay in ms (default: 2000)
 *
 * NOT part of the Turbo build — run independently (Node >=24 runs TS directly):
 *   node --env-file=.env src/index.ts
 */

import { createHmac, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? "3099");
const EVE_WEBHOOK_SECRET = process.env.EVE_WEBHOOK_SECRET ?? "";
const HOGSEND_API_URL = process.env.HOGSEND_API_URL ?? "http://localhost:3002";
const HOGSEND_CALLBACK_URL =
  process.env.HOGSEND_CALLBACK_URL ?? `${HOGSEND_API_URL}/v1/webhooks/eve`;
const HITL_DELAY_MS = Number(process.env.HITL_DELAY_MS ?? "2000");

if (!EVE_WEBHOOK_SECRET) {
  console.warn(
    "[eve-agent] EVE_WEBHOOK_SECRET is not set — callbacks will be sent " +
      "UNSIGNED, and Hogsend's fail-closed webhook will reject them with 401. " +
      "Set EVE_WEBHOOK_SECRET to the same value on both sides to receive them.",
  );
}

// ---------------------------------------------------------------------------
// Session store (in-memory, not persistent)
// ---------------------------------------------------------------------------

interface Session {
  sessionId: string;
  agent: string;
  userId: string;
  callbackEvent: string;
  input: Record<string, unknown>;
  startedAt: string;
}

const sessions = new Map<string, Session>();

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/**
 * Minimal retention-strategist agent loop.
 *
 * In a real Eve deployment this would:
 *  - Pull contact + event history from a data source
 *  - Run an LLM reasoning loop with tools (including HITL approval steps)
 *  - Produce a typed `play` (action + reason + optional detail)
 *
 * Here we simulate the delay and return a hard-coded "offer_discount" play
 * so the integration is testable without an AI provider or human in the loop.
 */
async function runAgent(session: Session): Promise<void> {
  // Simulate the HITL review window.
  await new Promise<void>((resolve) => setTimeout(resolve, HITL_DELAY_MS));

  const play = {
    action: "offer_discount",
    reason:
      "User showed high churn-risk signals. A targeted discount offer is the recommended save play.",
    detail:
      "Reply to this email and mention code SAVE20 — we'll apply 20% off your next 3 months.",
  };

  const callbackPayload = {
    sessionId: session.sessionId,
    userId: session.userId,
    event: session.callbackEvent,
    play,
  };

  const body = JSON.stringify(callbackPayload);

  console.log(
    `[eve-agent] Posting callback for session ${session.sessionId} (userId=${session.userId})`,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Sign the EXACT body bytes with HMAC-SHA256 (lowercase hex) under
  // x-eve-signature — Hogsend's `hmac-hex` signature source verifies over these
  // same bytes. Without a secret set, no signature is sent and the fail-closed
  // route will 401 (set EVE_WEBHOOK_SECRET on both sides to receive callbacks).
  if (EVE_WEBHOOK_SECRET) {
    headers["x-eve-signature"] = createHmac("sha256", EVE_WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
  }

  try {
    const res = await fetch(HOGSEND_CALLBACK_URL, {
      method: "POST",
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[eve-agent] Callback failed: ${res.status} ${res.statusText} — ${text}`,
      );
    } else {
      console.log(
        `[eve-agent] Callback accepted (${res.status}) for session ${session.sessionId}`,
      );
    }
  } catch (err) {
    console.error("[eve-agent] Callback fetch error:", err);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = new Hono();

/** Health check. */
app.get("/health", (c) => c.json({ ok: true, service: "eve-agent" }));

/**
 * Session start endpoint — mirrors the Eve platform contract that
 * `startEveSession()` in apps/api calls.
 *
 * Body: { agent, input?, metadata: { userId, callbackEvent } }
 */
app.post("/eve/v1/session", async (c) => {
  let body: {
    agent: string;
    input?: Record<string, unknown>;
    metadata: { userId: string; callbackEvent: string };
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { agent, input, metadata } = body;

  if (!agent || !metadata?.userId || !metadata?.callbackEvent) {
    return c.json(
      {
        error:
          "Missing required fields: agent, metadata.userId, metadata.callbackEvent",
      },
      400,
    );
  }

  const sessionId = `ses_${randomUUID().replace(/-/g, "")}`;
  const session: Session = {
    sessionId,
    agent,
    userId: metadata.userId,
    callbackEvent: metadata.callbackEvent,
    input: input ?? {},
    startedAt: new Date().toISOString(),
  };

  sessions.set(sessionId, session);
  console.log(
    `[eve-agent] Started session ${sessionId} for agent=${agent} userId=${metadata.userId}`,
  );

  // Kick off the agent loop in the background — do not await.
  void runAgent(session).catch((err) => {
    console.error(
      `[eve-agent] Agent loop error for session ${sessionId}:`,
      err,
    );
  });

  return c.json({ sessionId }, 201);
});

/** Session status endpoint — useful for debugging. */
app.get("/eve/v1/session/:id", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  return c.json(session);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(
    `[eve-agent] Listening on http://localhost:${PORT} — callback target: ${HOGSEND_CALLBACK_URL}`,
  );
});
