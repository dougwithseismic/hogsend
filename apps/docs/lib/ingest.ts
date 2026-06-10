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

/**
 * forwardToIngest — POSTs one lifecycle event to /v1/events. Returns true
 * when the upstream accepted it. Throws nothing: network and upstream
 * failures both come back as false so callers map them to a 502.
 */
export async function forwardToIngest(
  body: IngestEventBody,
  idempotencyKey: string,
): Promise<boolean> {
  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const ingestKey = process.env.HOGSEND_INGEST_KEY;
  if (!ingestUrl || !ingestKey) return false;

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
    return upstream.ok;
  } catch {
    return false;
  }
}
