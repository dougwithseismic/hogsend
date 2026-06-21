/**
 * Eve session integration — Tier-3 durable HITL.
 *
 * Starts a session on the Eve platform for a given agent, passing the userId
 * and callbackEvent in metadata so Eve can POST its terminal result back to
 * the Hogsend webhook endpoint (`POST /v1/webhooks/eve`), which resumes the
 * parked `ctx.waitForEvent`.
 *
 * No Eve SDK — just a `fetch` POST. The journey parks on `ctx.waitForEvent`
 * after calling this; there is zero Eve-specific code in the engine or worker.
 *
 * Required env vars:
 *   EVE_BASE_URL   — e.g. https://eve.example.com
 *   EVE_TOKEN      — bearer token for Eve's /eve/v1/session endpoint
 */

export interface StartEveSessionOptions {
  /** The Eve agent identifier to activate. */
  agent: string;
  /** The Hogsend user id — passed as `metadata.userId` so Eve can scope its work. */
  userId: string;
  /**
   * The event name Eve should include in its callback payload so the journey's
   * `ctx.waitForEvent` can match it.
   */
  callbackEvent: string;
  /** Arbitrary input passed verbatim to the Eve agent. */
  input?: Record<string, unknown>;
}

export interface StartEveSessionResult {
  /** The Eve session id returned by the API. */
  sessionId: string;
}

/**
 * POST to `${EVE_BASE_URL}/eve/v1/session` and return the session id.
 *
 * Throws on HTTP errors or when `EVE_BASE_URL` / `EVE_TOKEN` are not set.
 */
export async function startEveSession(
  opts: StartEveSessionOptions,
): Promise<StartEveSessionResult> {
  const baseUrl = process.env.EVE_BASE_URL;
  const token = process.env.EVE_TOKEN;

  if (!baseUrl) {
    throw new Error("EVE_BASE_URL is not set");
  }
  if (!token) {
    throw new Error("EVE_TOKEN is not set");
  }

  const body = {
    agent: opts.agent,
    input: opts.input ?? {},
    metadata: {
      userId: opts.userId,
      callbackEvent: opts.callbackEvent,
    },
  };

  const response = await fetch(`${baseUrl}/eve/v1/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Eve session start failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  const data = (await response.json()) as { sessionId?: string; id?: string };
  const sessionId = data.sessionId ?? data.id;

  if (!sessionId) {
    throw new Error("Eve session response did not include a sessionId");
  }

  return { sessionId };
}
