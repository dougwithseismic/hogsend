import { NextResponse } from "next/server";
import { EMAIL_PATTERN, forwardToIngest, ingestConfigured } from "@/lib/ingest";

/**
 * The qualification answers. Kept as closed sets so each contact property
 * stays low-cardinality — Hogsend journeys and PostHog cohorts both filter on
 * them. `role` is the seat; `intent` and `provider` are the live-demo opener
 * steps, captured anonymously and flushed here once the email is known.
 */
const ROLES = [
  "founder",
  "engineer",
  "marketing_growth",
  "sales",
  "just_curious",
] as const;

const INTENTS = [
  "replacing_tool",
  "posthog_lifecycle",
  "client_work",
  "exploring",
] as const;

const PROVIDERS = ["resend", "postmark", "sendgrid", "other", "none"] as const;

type Role = (typeof ROLES)[number];
type Intent = (typeof INTENTS)[number];
type Provider = (typeof PROVIDERS)[number];

const WEBSITE_MAX_LENGTH = 200;

function sanitizeRole(value: unknown): Role | undefined {
  return ROLES.includes(value as Role) ? (value as Role) : undefined;
}

function sanitizeIntent(value: unknown): Intent | undefined {
  return INTENTS.includes(value as Intent) ? (value as Intent) : undefined;
}

function sanitizeProvider(value: unknown): Provider | undefined {
  return PROVIDERS.includes(value as Provider)
    ? (value as Provider)
    : undefined;
}

/**
 * sanitizeWebsite — trims, bounds, and normalises the optional website to an
 * https URL. Anything odd is dropped rather than rejected: a dodgy website
 * must never block the enrichment event.
 */
function sanitizeWebsite(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > WEBSITE_MAX_LENGTH) {
    return undefined;
  }
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (!url.hostname.includes(".")) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * POST /api/profile — accepts { email, role?, website?, intent?, provider? }
 * from the multistep capture form and forwards a `docs.profile_updated` event
 * to the Hogsend ingest API, carrying the answers as contact properties. The
 * footer/referral form posts each enrichment step independently; the live
 * demo gathers intent/role/provider anonymously up front and flushes them in
 * one call once the subscriber's email is known. Either way, dropping off
 * keeps everything answered so far.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!ingestConfigured()) {
    return NextResponse.json(
      { error: "capture not configured" },
      { status: 503 },
    );
  }

  let email: unknown;
  let role: Role | undefined;
  let website: string | undefined;
  let intent: Intent | undefined;
  let provider: Provider | undefined;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      role?: unknown;
      website?: unknown;
      intent?: unknown;
      provider?: unknown;
    };
    email = body?.email;
    role = sanitizeRole(body?.role);
    website = sanitizeWebsite(body?.website);
    intent = sanitizeIntent(body?.intent);
    provider = sanitizeProvider(body?.provider);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  if (!role && !website && !intent && !provider) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const fields = [
    role ? "role" : null,
    website ? "website" : null,
    intent ? "intent" : null,
    provider ? "provider" : null,
  ]
    .filter(Boolean)
    .join("-");

  const ok = await forwardToIngest(
    {
      name: "docs.profile_updated",
      email: normalizedEmail,
      contactProperties: {
        ...(role ? { role } : {}),
        ...(website ? { website } : {}),
        ...(intent ? { intent } : {}),
        ...(provider ? { provider } : {}),
      },
      eventProperties: { source: "docs-site", fields },
    },
    `docs-profile-${fields}-${normalizedEmail}`,
  );

  if (!ok) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
