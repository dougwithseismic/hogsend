/**
 * Server-side forwarding to the external Hogsend ingest API. The ingest key
 * never leaves the server; routes answer 503 when the env isn't configured
 * so the client can fail quietly.
 */

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type IngestEventBody = {
  name: string;
  email: string;
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
