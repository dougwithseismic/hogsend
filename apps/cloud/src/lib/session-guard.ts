/**
 * The "where does this visitor belong" rules, as pure functions.
 *
 * Kept free of `next/headers`, Better Auth and the database on purpose: the
 * middleware (`proxy.ts`) can only see whether a session COOKIE exists, so the
 * second half of the routing rule — signed in, but no organization yet — has to
 * run in the server components that can read the database. Isolating the rule
 * here means it is unit-testable without a request, and `session.ts` stays a
 * thin adapter that fetches, decides, redirects.
 */

/** The minimum an organization is known by while routing. */
export type OrganizationSummary = { id: string; name: string };

export type DashboardAccess =
  | { action: "redirect"; to: "/login" | "/create-org" }
  | { action: "allow"; organization: OrganizationSummary };

/**
 * Which organization a dashboard page renders, if any.
 *
 * A stale `activeOrganizationId` (the org was left or deleted, but the session
 * row still names it) falls back to the first membership rather than bouncing
 * the user to `/create-org` — they DO have an org, so sending them to create a
 * second one would be wrong.
 */
export function resolveDashboardAccess(input: {
  hasSession: boolean;
  activeOrganizationId?: string | null;
  organizations: OrganizationSummary[];
}): DashboardAccess {
  if (!input.hasSession) return { action: "redirect", to: "/login" };

  const [first] = input.organizations;
  if (!first) return { action: "redirect", to: "/create-org" };

  const active = input.activeOrganizationId
    ? input.organizations.find((org) => org.id === input.activeOrganizationId)
    : undefined;

  return { action: "allow", organization: active ?? first };
}

export type CreateOrgAccess =
  | { action: "redirect"; to: "/login" | "/" }
  | { action: "allow" };

/**
 * The create-org step is for a signed-in visitor with NO organization. A member
 * of one already has somewhere to be, so the step is skipped rather than
 * offering a second org nobody asked for (adding orgs later is a settings
 * action, not a signup step).
 */
export function resolveCreateOrgAccess(input: {
  hasSession: boolean;
  organizationCount: number;
}): CreateOrgAccess {
  if (!input.hasSession) return { action: "redirect", to: "/login" };
  if (input.organizationCount > 0) return { action: "redirect", to: "/" };
  return { action: "allow" };
}
