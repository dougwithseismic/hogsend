import { NextResponse } from "next/server";
import { AnalyticsEvent } from "@/lib/analytics";
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

/**
 * The live-demo qualifier closed sets. Same low-cardinality discipline as
 * role/intent/provider — Hogsend journeys and PostHog cohorts both filter on
 * them. Each is the exact closed value the qualifier chips emit. `setup_interest`
 * is the non-PostHog offer answer; a "yes" also fires `docs.setup.interested`
 * (below) so the dogfood lead alert can pick it up.
 */
const POSTHOG_USAGES = ["yes", "evaluating", "not_yet"] as const;
const POSTHOG_DEPTHS = [
  "events_dashboards",
  "funnels_cohorts",
  "most_of_platform",
  "live_in_it",
] as const;
const LIFECYCLES = [
  "not_yet",
  "few_one_offs",
  "another_tool",
  "hand_rolled",
] as const;
const BUILDINGS = [
  "b2b_saas",
  "consumer_app",
  "ecommerce",
  "agency_clients",
  "other",
] as const;
const SETUP_INTERESTS = ["yes", "maybe_later", "just_looking"] as const;

type Role = (typeof ROLES)[number];
type Intent = (typeof INTENTS)[number];
type Provider = (typeof PROVIDERS)[number];
type PosthogUsage = (typeof POSTHOG_USAGES)[number];
type PosthogDepth = (typeof POSTHOG_DEPTHS)[number];
type Lifecycle = (typeof LIFECYCLES)[number];
type Building = (typeof BUILDINGS)[number];
type SetupInterest = (typeof SETUP_INTERESTS)[number];

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

function sanitizePosthogUsage(value: unknown): PosthogUsage | undefined {
  return POSTHOG_USAGES.includes(value as PosthogUsage)
    ? (value as PosthogUsage)
    : undefined;
}

function sanitizePosthogDepth(value: unknown): PosthogDepth | undefined {
  return POSTHOG_DEPTHS.includes(value as PosthogDepth)
    ? (value as PosthogDepth)
    : undefined;
}

function sanitizeLifecycle(value: unknown): Lifecycle | undefined {
  return LIFECYCLES.includes(value as Lifecycle)
    ? (value as Lifecycle)
    : undefined;
}

function sanitizeBuilding(value: unknown): Building | undefined {
  return BUILDINGS.includes(value as Building)
    ? (value as Building)
    : undefined;
}

function sanitizeSetupInterest(value: unknown): SetupInterest | undefined {
  return SETUP_INTERESTS.includes(value as SetupInterest)
    ? (value as SetupInterest)
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
 * POST /api/profile — accepts { email, role?, website?, intent?, provider?,
 * posthog_usage?, posthog_depth?, lifecycle?, building?, setup_interest? } from
 * the multistep capture form and forwards a `docs.profile_updated` event to the
 * Hogsend ingest API, carrying the answers as contact properties. The
 * footer/referral form posts each enrichment step independently; the live demo
 * gathers the qualifier answers anonymously up front and flushes them in one
 * call once the subscriber's email is known. Either way, dropping off keeps
 * everything answered so far. A `setup_interest: "yes"` hand-raise ALSO fires a
 * dedicated `docs.setup.interested` event (carrying the email) so the dogfood
 * side can route it into the existing lead alert.
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
  let posthogUsage: PosthogUsage | undefined;
  let posthogDepth: PosthogDepth | undefined;
  let lifecycle: Lifecycle | undefined;
  let building: Building | undefined;
  let setupInterest: SetupInterest | undefined;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      role?: unknown;
      website?: unknown;
      intent?: unknown;
      provider?: unknown;
      posthog_usage?: unknown;
      posthog_depth?: unknown;
      lifecycle?: unknown;
      building?: unknown;
      setup_interest?: unknown;
    };
    email = body?.email;
    role = sanitizeRole(body?.role);
    website = sanitizeWebsite(body?.website);
    intent = sanitizeIntent(body?.intent);
    provider = sanitizeProvider(body?.provider);
    posthogUsage = sanitizePosthogUsage(body?.posthog_usage);
    posthogDepth = sanitizePosthogDepth(body?.posthog_depth);
    lifecycle = sanitizeLifecycle(body?.lifecycle);
    building = sanitizeBuilding(body?.building);
    setupInterest = sanitizeSetupInterest(body?.setup_interest);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  if (
    !role &&
    !website &&
    !intent &&
    !provider &&
    !posthogUsage &&
    !posthogDepth &&
    !lifecycle &&
    !building &&
    !setupInterest
  ) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const fields = [
    role ? "role" : null,
    website ? "website" : null,
    intent ? "intent" : null,
    provider ? "provider" : null,
    posthogUsage ? "posthog_usage" : null,
    posthogDepth ? "posthog_depth" : null,
    lifecycle ? "lifecycle" : null,
    building ? "building" : null,
    setupInterest ? "setup_interest" : null,
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
        ...(posthogUsage ? { posthog_usage: posthogUsage } : {}),
        ...(posthogDepth ? { posthog_depth: posthogDepth } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(building ? { building } : {}),
        ...(setupInterest ? { setup_interest: setupInterest } : {}),
      },
      eventProperties: { source: "docs-site", fields },
    },
    `docs-profile-${fields}-${normalizedEmail}`,
  );

  if (!ok) {
    return NextResponse.json({ error: "upstream failed" }, { status: 502 });
  }

  // A "yes, tell me more" hand-raise is a lead. Beyond recording it as a
  // contact property (above), fire the dedicated `docs.setup.interested` event
  // carrying the email so the dogfood side can route it into the existing
  // lead-alert mechanism (notify-lead / docs.lead.flagged) and ping Doug.
  // Best-effort: a failed alert never fails the property write — the contact
  // is already enriched, so we still return 202.
  if (setupInterest === "yes") {
    await forwardToIngest(
      {
        name: AnalyticsEvent.SETUP_INTERESTED,
        email: normalizedEmail,
        eventProperties: { source: "docs-site" },
      },
      `docs-setup-interested-${normalizedEmail}`,
    );
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
