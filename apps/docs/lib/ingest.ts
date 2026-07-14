/**
 * Server-side forwarding to the external Hogsend ingest API. The ingest key
 * never leaves the server; routes answer 503 when the env isn't configured
 * so the client can fail quietly.
 */

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Longest accepted per-mount submission id (the double-click dedupe key). */
export const SUBMISSION_ID_MAX = 100;

/** Trim + bound an optional free-text field; drop anything odd rather than 400. */
export function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Trim + TRUNCATE an optional free-text field — for content that must
 * survive an over-long submission (a customer's note should reach the
 * operator cut short, not silently vanish while the UI reports success).
 */
export function truncatedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

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

/** The identified-bell chain needs the ingest pair plus the mint secret. */
export function feedTokenConfigured(): boolean {
  return Boolean(
    process.env.HOGSEND_INGEST_URL &&
      process.env.HOGSEND_INGEST_KEY &&
      process.env.HOGSEND_FEED_TOKEN_SECRET,
  );
}

/**
 * Secret-path contact fold: assert { email, userId } onto ONE contact via
 * PUT /v1/contacts. A signed-in visitor proved their email (OTP / magic-link),
 * so their Better Auth id becomes the contact's external_id — the canonical feed
 * recipient key AND the key subsequent identified captures resolve, so a demo
 * event + its minted link + the resulting link.clicked all land on the same
 * contact (no phantom external_id twin). Optionally writes the first name as a
 * contact property so lifecycle journeys (and the Studio) can greet by name.
 * Idempotent upsert; false on any failure.
 */
export async function foldContactIdentity(input: {
  email: string;
  userId: string;
  firstName?: string;
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
        body: JSON.stringify({
          email: input.email,
          userId: input.userId,
          ...(input.firstName
            ? { properties: { firstName: input.firstName } }
            : {}),
        }),
      },
    );
    return upstream.ok;
  } catch {
    return false;
  }
}

/**
 * Mint the browser feed userToken via the dogfood-hosted signer
 * (POST /v1/course/feed-token, shared `x-course-token-secret` — the engine's own
 * signing secret lives only on the dogfood deploy; this app holds just the mint
 * secret). Reused verbatim from the course's bridge (same endpoint). Null on any
 * failure.
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
 * A first name we may ALREADY know for this email from a prior Hogsend
 * engagement (an earlier subscribe, the course, …) via GET /v1/contacts/find.
 * Used so the docs sign-up never asks for a name we already have. Null when
 * unconfigured, not found, or on any failure (caller then asks for it).
 */
export async function getContactFirstName(input: {
  email: string;
}): Promise<string | null> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const ingestKey = process.env.HOGSEND_INGEST_KEY;
  if (!ingestUrl || !ingestKey) return null;
  try {
    const url = new URL(`${ingestUrl.replace(/\/+$/, "")}/v1/contacts/find`);
    url.searchParams.set("email", input.email);
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${ingestKey}` },
      // Bounded: this runs inside Better Auth's user-create hook, so a slow or
      // down engine must NOT hang sign-up — time out and let the client ask.
      signal: AbortSignal.timeout(2500),
    });
    if (!upstream.ok) return null;
    const body = (await upstream.json().catch(() => null)) as {
      contacts?: Array<{ properties?: Record<string, unknown> }>;
    } | null;
    const firstName = body?.contacts?.[0]?.properties?.firstName;
    return typeof firstName === "string" && firstName ? firstName : null;
  } catch {
    return null;
  }
}

/**
 * The contact's CANONICAL feed key (its `external_id`) for this email. This is
 * the recipient key journeys write to and the bell must poll — and it is NOT
 * always the Better Auth user id: a contact identified earlier (PostHog sync,
 * the course) can carry a different `external_id`, with the Better Auth id linked
 * only as an alias. The feed's recipient resolver matches `external_id` directly
 * (not aliases), so minting the bell's userToken for the Better Auth id would
 * poll a key that never matches where events land. Minting for the canonical key
 * keeps the bell's read aligned with the journey's write. Null when unconfigured,
 * unknown, or on failure (caller falls back to the Better Auth id, correct for a
 * fresh contact whose `external_id` IS the Better Auth id).
 */
export async function resolveContactKey(input: {
  email: string;
}): Promise<string | null> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const ingestKey = process.env.HOGSEND_INGEST_KEY;
  if (!ingestUrl || !ingestKey) return null;
  try {
    const url = new URL(`${ingestUrl.replace(/\/+$/, "")}/v1/contacts/find`);
    url.searchParams.set("email", input.email);
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${ingestKey}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!upstream.ok) return null;
    const body = (await upstream.json().catch(() => null)) as {
      contacts?: Array<{ externalId?: string | null }>;
    } | null;
    const externalId = body?.contacts?.[0]?.externalId;
    return typeof externalId === "string" && externalId ? externalId : null;
  } catch {
    return null;
  }
}
