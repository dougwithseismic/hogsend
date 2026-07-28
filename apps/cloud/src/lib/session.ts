import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "../db";
import { organizations } from "../db/schema";
import type { OrganizationRow } from "../services/orgs";
import { auth } from "./auth";
import {
  type OrganizationSummary,
  resolveCreateOrgAccess,
  resolveDashboardAccess,
} from "./session-guard";

/**
 * The one read every server component in the dashboard starts from.
 *
 * Two stores answer "who is this": Better Auth (user, session, memberships) and
 * the control plane's own `cloud.organizations` mirror (region, plan,
 * placement). A page needs both, and neither is worth re-deriving per page — so
 * this module resolves them together and applies the routing rules from
 * `session-guard.ts`.
 *
 * The middleware's cookie check is NOT a substitute: it runs on the edge with
 * no database, so a forged cookie reaches these helpers, and `getSession`
 * rejecting it here is what actually keeps a page from rendering.
 */

export type CloudUser = { id: string; name: string; email: string };

export type SessionContext = {
  user: CloudUser;
  activeOrganizationId: string | null;
  organizations: OrganizationSummary[];
};

/**
 * The signed-in user + their memberships, or null when there is no session.
 *
 * `cache` dedupes it per request: the nav rail's org switcher and the page it
 * frames both need this, and they render independently — without it every
 * dashboard render would run getSession + listOrganizations twice.
 */
export const readSessionContext = cache(
  async (): Promise<SessionContext | null> => {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session) return null;

    const memberships = await auth.api.listOrganizations({
      headers: requestHeaders,
    });

    return {
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
      activeOrganizationId: session.session.activeOrganizationId ?? null,
      organizations: memberships.map((org) => ({ id: org.id, name: org.name })),
    };
  },
);

export type ActiveOrgContext = {
  user: CloudUser;
  /** Better Auth's organization — the identity the session switches between. */
  organization: OrganizationSummary;
  /** The control-plane mirror: region, plan, placement, trial clock. */
  record: OrganizationRow;
  /** Every org this user belongs to — the switcher's options. */
  organizations: OrganizationSummary[];
};

/**
 * Guard for every dashboard page: no session → `/login`, no organization →
 * `/create-org`, otherwise the active organization and its control-plane row.
 */
export async function requireActiveOrganization(): Promise<ActiveOrgContext> {
  const context = await readSessionContext();
  if (!context) redirect("/login");

  const decision = resolveDashboardAccess({
    hasSession: true,
    activeOrganizationId: context.activeOrganizationId,
    organizations: context.organizations,
  });
  if (decision.action === "redirect") redirect(decision.to);

  const [record] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, decision.organization.id))
    .limit(1);
  if (!record) {
    // `provisionOrganization` creates both rows or neither, so this is a
    // hand-edited database, not a state the app can route out of — a redirect
    // to /create-org would silently mint a SECOND organization.
    throw new Error(
      `Organization "${decision.organization.id}" has no control-plane record`,
    );
  }

  return {
    user: context.user,
    organization: decision.organization,
    record,
    organizations: context.organizations,
  };
}

/** Guard for `/create-org`: signed in, and not already in an organization. */
export async function requireCreateOrgAccess(): Promise<{ user: CloudUser }> {
  const context = await readSessionContext();
  if (!context) redirect("/login");

  const decision = resolveCreateOrgAccess({
    hasSession: true,
    organizationCount: context.organizations.length,
  });
  if (decision.action === "redirect") redirect(decision.to);

  return { user: context.user };
}
