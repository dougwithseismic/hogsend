/**
 * Server-side forwarding to the external Hogsend ingest API. The ingest key
 * never leaves the server; routes answer 503 when the env isn't configured
 * so the client can fail quietly.
 */

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type IngestEventBody = {
  name: string;
  /**
   * The contact's email — the primary identity arm for every PII-carrying
   * forward (subscribe, deploy-clicked, …). Optional because a few events are
   * anonymous-by-design and identify via `userId` or are accepted by the
   * upstream on `anonymousId` alone (e.g. `referral.visited`, where the
   * visitor has no email and the only token that travels is the opaque
   * referrer ref). When omitted, `userId` (or the upstream's anon handling)
   * must carry identity — the engine's `/v1/events` still enforces its own
   * identity gate.
   */
  email?: string;
  /**
   * A stable Hogsend contact key used as the 1st-precedence identity arm when
   * present (the engine resolves `external → email → anonymous → discord`).
   * Only set this when you genuinely want to attribute the event to that
   * contact — for `referral.visited` we deliberately do NOT pass the referrer
   * ref here (that would attribute the visit to the referrer, not the
   * anonymous visitor); the ref rides as a contact property instead.
   */
  userId?: string;
  /**
   * The subscribing session's PostHog anonymous distinct_id, forwarded as a
   * top-level identity field (engine ≥0.18) — NOT a contact property. The
   * engine's resolver uses it as the 2nd-precedence key, so the returned
   * `contactKey` equals this browser id and the session's anonymous events
   * land on the same PostHog person with zero merge calls. Email/userId still
   * carry identity; `anonymousId` is an extra, never a standalone arm.
   */
  anonymousId?: string;
  contactProperties?: Record<string, unknown>;
  eventProperties?: Record<string, unknown>;
  lists?: Record<string, boolean>;
};

export function ingestConfigured(): boolean {
  return Boolean(
    process.env.HOGSEND_INGEST_URL && process.env.HOGSEND_INGEST_KEY,
  );
}

type IngestAccepted = {
  /**
   * The contact's canonical Hogsend key, when the upstream provides it (engine
   * ≥0.18). It carries no PII — safe to hand to client-side analytics
   * `identify()` so the session joins the person the contact's email events
   * land on.
   */
  contactKey?: string;
};

/**
 * forwardToIngest — POSTs one lifecycle event to /v1/events. Returns the
 * accepted-response body (truthy) on success, null on any failure. Throws
 * nothing: network and upstream failures both come back as null so callers
 * map them to a 502.
 */
export async function forwardToIngest(
  body: IngestEventBody,
  idempotencyKey: string,
): Promise<IngestAccepted | null> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const ingestKey = process.env.HOGSEND_INGEST_KEY;
  if (!ingestUrl || !ingestKey) return null;

  try {
    const upstream = await fetch(`${ingestUrl.replace(/\/+$/, "")}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestKey}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) return null;
    const accepted = (await upstream.json().catch(() => ({}))) as {
      contactKey?: unknown;
    };
    return typeof accepted.contactKey === "string"
      ? { contactKey: accepted.contactKey }
      : {};
  } catch {
    return null;
  }
}

/** The identified-bell chain needs the ingest pair plus the mint secret. */
export function feedTokenConfigured(): boolean {
  return Boolean(
    process.env.HOGSEND_INGEST_URL &&
      process.env.HOGSEND_INGEST_KEY &&
      process.env.HOGSEND_FEED_TOKEN_SECRET,
  );
}

/**
 * Secret-path contact fold: assert { email, userId } onto one contact via
 * PUT /v1/contacts (the sanctioned fill-in-link — magic-link login proved the
 * email, so the Better Auth id becomes the contact's external_id, which is
 * the canonical feed recipient key). Idempotent upsert; false on any failure.
 */
export async function foldContactIdentity(input: {
  email: string;
  userId: string;
}): Promise<boolean> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const ingestKey = process.env.HOGSEND_INGEST_KEY;
  if (!ingestUrl || !ingestKey) return false;
  try {
    const upstream = await fetch(
      `${ingestUrl.replace(/\/+$/, "")}/v1/contacts`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingestKey}`,
        },
        body: JSON.stringify(input),
      },
    );
    return upstream.ok;
  } catch {
    return false;
  }
}

/**
 * Mint the browser feed userToken via the dogfood-hosted signer
 * (POST /v1/course/feed-token, shared `x-course-token-secret`). The signing
 * secret is the engine's own — only the dogfood deploy holds it; this app
 * holds just the mint secret. Null on any failure.
 */
export async function mintFeedToken(
  userId: string,
): Promise<{ token: string; expiresInSeconds: number } | null> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const secret = process.env.HOGSEND_FEED_TOKEN_SECRET;
  if (!ingestUrl || !secret) return null;
  try {
    const upstream = await fetch(
      `${ingestUrl.replace(/\/+$/, "")}/v1/course/feed-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-course-token-secret": secret,
        },
        body: JSON.stringify({ userId }),
      },
    );
    if (!upstream.ok) return null;
    const body = (await upstream.json().catch(() => null)) as {
      token?: unknown;
      expiresInSeconds?: unknown;
    } | null;
    if (!body || typeof body.token !== "string") return null;
    return {
      token: body.token,
      expiresInSeconds:
        typeof body.expiresInSeconds === "number"
          ? body.expiresInSeconds
          : 3600,
    };
  } catch {
    return null;
  }
}

/**
 * The referral-visit webhook needs the same ingest base URL plus its OWN shared
 * secret (the dogfood `referral-visited` webhook source verifies the header).
 * Separate from `HOGSEND_INGEST_KEY` because it hits a different endpoint with a
 * different auth scheme.
 */
export function referralVisitedConfigured(): boolean {
  return Boolean(
    process.env.HOGSEND_INGEST_URL && process.env.HOGSEND_REFERRAL_SECRET,
  );
}

/**
 * forwardReferralVisited — POSTs an ANONYMOUS referral visit to the dogfood's
 * `referral-visited` webhook source. NOT `/v1/events`: that route enforces
 * `requireIdentity` and would 400 an email-less, userId-less visit. The webhook
 * source feeds `ingestEvent()` directly, which accepts an `anonymousId`-only
 * event. Auth is the shared `x-referral-secret` header (the key never reaches
 * the client). Returns true on a 2xx; throws nothing — failures come back false.
 */
export async function forwardReferralVisited(
  body: { ref: string; anonymousId: string },
  idempotencyKey: string,
): Promise<boolean> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const secret = process.env.HOGSEND_REFERRAL_SECRET;
  if (!ingestUrl || !secret) return false;

  try {
    const upstream = await fetch(
      `${ingestUrl.replace(/\/+$/, "")}/v1/webhooks/referral-visited`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-referral-secret": secret,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    );
    return upstream.ok;
  } catch {
    return false;
  }
}
