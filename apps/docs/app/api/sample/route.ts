import { NextResponse } from "next/server";
import { EMAIL_PATTERN, forwardToIngest, ingestConfigured } from "@/lib/ingest";

/**
 * The templates a visitor can request a sample of. Kept as a closed set
 * matching the backend's template registry keys — the dogfood app's journey
 * picks the component to send off this exact string.
 */
const SAMPLE_TEMPLATES = [
  // Legacy dogfood sample keys (pre-canonical naming) — old links still work.
  "activation/welcome",
  "activation/nudge",
  "lifecycle/trial-expiring",
  // Canonical registry keys — the full /emails gallery. Must stay in sync
  // with apps/api/src/emails/registry.ts and the dogfood sample journey.
  "activation-quickstart",
  "activation-nudge",
  "activation-feature-highlight",
  "activation-community",
  "onboarding/come-back-to-it",
  "onboarding-personalized",
  "preboarding/manager-welcome",
  "conversion-usage-milestone",
  "conversion-trial-expiring",
  "conversion-winback-offer",
  "sales/proposal-opened",
  "sales/whitepaper-follow-up",
  "events/were-live",
  "events/qr-checkin",
  "retention-weekly-digest",
  "retention-achievement",
  "retention/founder-checkin",
  "content/weekly-articles",
  "groups/account-digest",
  "team/invite-teammate",
  "reactivation-checkin",
  "reactivation-final-nudge",
  "winback/whats-new",
  "winback/final-note",
  "billing/upcoming-payment",
  "churn-payment-failed",
  "feedback-nps-survey",
  "feedback/csat",
  "feedback/did-this-help",
  "advocacy/review-ask",
  "impact/journey-lift-report",
  "welcome",
  "transactional/verify-email",
  "transactional/magic-link",
  "transactional/receipt",
  "marketing/product-update",
] as const;

type SampleTemplate = (typeof SAMPLE_TEMPLATES)[number];

function sanitizeTemplate(value: unknown): SampleTemplate | undefined {
  return SAMPLE_TEMPLATES.includes(value as SampleTemplate)
    ? (value as SampleTemplate)
    : undefined;
}

/**
 * POST /api/sample — accepts { email, template } from the /emails gallery and
 * forwards a `docs.sample_requested` event to the Hogsend ingest API. The
 * dogfood app listens for it and sends a real rendered sample of that
 * template. Idempotency is per template per HOUR per address — wide enough to
 * absorb double-clicks (the UI lockout and the journey's 10-minute suppress
 * already guard abuse), narrow enough that a request swallowed downstream
 * (e.g. mid-deploy) doesn't poison the whole day's retries.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!ingestConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }

  let email: unknown;
  let template: SampleTemplate | undefined;
  let firstName = "";
  try {
    const body = (await request.json()) as {
      email?: unknown;
      template?: unknown;
      name?: unknown;
    };
    email = body?.email;
    template = sanitizeTemplate(body?.template);
    // Optional personalization — the home demo forwards the signed-up name so
    // the sample greets the real person (the gallery sends none → "Sam Sample").
    if (typeof body?.name === "string") {
      firstName = body.name.trim().slice(0, 80);
    }
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  if (!template) {
    return NextResponse.json({ error: "invalid template" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const templateSlug = template.replaceAll("/", "-");
  const hour = new Date().toISOString().slice(0, 13);

  const ok = await forwardToIngest(
    {
      name: "docs.sample_requested",
      email: normalizedEmail,
      eventProperties: {
        source: "docs-site",
        template,
        ...(firstName ? { firstName } : {}),
      },
    },
    `docs-sample-${templateSlug}-${hour}-${normalizedEmail}`,
  );

  if (!ok) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
