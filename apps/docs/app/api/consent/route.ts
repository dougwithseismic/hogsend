import { NextResponse } from "next/server";
import { forwardToIngest, ingestConfigured } from "@/lib/ingest";

/**
 * POST /api/consent — forwards a `consent.granted` / `consent.withdrawn`
 * lifecycle event to the Hogsend ingest API. This is the server-side audit
 * trail for the cookie banner (GDPR art. 7(1): consent must be demonstrable):
 * the device-local `hs_consent` ledger drives behaviour, this records it.
 *
 * Identity rides the visitor's PostHog distinct_id as `anonymousId` — the
 * engine's 3rd-precedence identity arm — so if the visitor later subscribes
 * (anonymousId-threaded contact), the consent event sits on the same contact
 * timeline. A never-identified visitor's event keys a bare anonymous contact,
 * which is exactly what a consent record for an anonymous device should be.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!ingestConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }

  let action: unknown;
  let distinctId: unknown;
  try {
    const body = (await request.json()) as {
      action?: unknown;
      distinctId?: unknown;
    };
    action = body?.action;
    distinctId = body?.distinctId;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (action !== "granted" && action !== "withdrawn") {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  if (
    typeof distinctId !== "string" ||
    distinctId.length === 0 ||
    distinctId.length > 200
  ) {
    return NextResponse.json({ error: "invalid distinctId" }, { status: 400 });
  }

  const ok = await forwardToIngest(
    {
      name: `consent.${action}`,
      anonymousId: distinctId,
      eventProperties: {
        surface: "docs-site",
        scope: "analytics-storage",
      },
    },
    // One decision per device per direction per day is plenty for the audit
    // trail; repeat clicks the same day dedupe upstream.
    `docs-consent-${action}-${new Date().toISOString().slice(0, 10)}-${distinctId}`,
  );

  if (!ok) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
