import { NextResponse } from "next/server";
import { EMAIL_PATTERN, forwardToIngest, ingestConfigured } from "@/lib/ingest";

/**
 * The templates a visitor can request a sample of. Kept as a closed set
 * matching the backend's template registry keys — the dogfood app's journey
 * picks the component to send off this exact string.
 */
const SAMPLE_TEMPLATES = [
  "activation/welcome",
  "activation/nudge",
  "lifecycle/trial-expiring",
  "marketing/product-update",
  "transactional/receipt",
  "transactional/magic-link",
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
 * template. Idempotency is per template per day per address, so repeat clicks
 * don't stack sends.
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
  try {
    const body = (await request.json()) as {
      email?: unknown;
      template?: unknown;
    };
    email = body?.email;
    template = sanitizeTemplate(body?.template);
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
  const day = new Date().toISOString().slice(0, 10);

  const ok = await forwardToIngest(
    {
      name: "docs.sample_requested",
      email: normalizedEmail,
      eventProperties: { source: "docs-site", template },
    },
    `docs-sample-${templateSlug}-${day}-${normalizedEmail}`,
  );

  if (!ok) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
