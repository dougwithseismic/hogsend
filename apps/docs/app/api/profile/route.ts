import { NextResponse } from "next/server";
import { EMAIL_PATTERN, forwardToIngest, ingestConfigured } from "@/lib/ingest";

/**
 * The post-signup qualification answers. Kept as a closed set so the contact
 * property stays low-cardinality — Hogsend journeys and PostHog cohorts both
 * filter on it.
 */
const ROLES = [
  "founder",
  "engineer",
  "marketing_growth",
  "sales",
  "just_curious",
] as const;

type Role = (typeof ROLES)[number];

const WEBSITE_MAX_LENGTH = 200;

function sanitizeRole(value: unknown): Role | undefined {
  return ROLES.includes(value as Role) ? (value as Role) : undefined;
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
 * POST /api/profile — accepts { email, role?, website? } from the multistep
 * capture form and forwards a `docs.profile_updated` event to the Hogsend
 * ingest API, carrying the answers as contact properties. Each enrichment
 * step posts independently, so dropping off after the role question still
 * keeps the role.
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
  try {
    const body = (await request.json()) as {
      email?: unknown;
      role?: unknown;
      website?: unknown;
    };
    email = body?.email;
    role = sanitizeRole(body?.role);
    website = sanitizeWebsite(body?.website);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  if (!role && !website) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const fields = [role ? "role" : null, website ? "website" : null]
    .filter(Boolean)
    .join("-");

  const ok = await forwardToIngest(
    {
      name: "docs.profile_updated",
      email: normalizedEmail,
      contactProperties: {
        ...(role ? { role } : {}),
        ...(website ? { website } : {}),
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
