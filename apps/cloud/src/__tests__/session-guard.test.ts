import { describe, expect, it } from "vitest";
import {
  resolveCreateOrgAccess,
  resolveDashboardAccess,
} from "../lib/session-guard";

/**
 * The half of the routing rule the edge middleware cannot answer: it sees a
 * cookie, never a membership. Pure functions, so no request and no database.
 */

const ACME = { id: "org_acme", name: "Acme" };
const BETA = { id: "org_beta", name: "Beta" };

describe("resolveDashboardAccess", () => {
  it("sends a signed-out visitor to /login", () => {
    expect(
      resolveDashboardAccess({ hasSession: false, organizations: [ACME] }),
    ).toEqual({ action: "redirect", to: "/login" });
  });

  it("sends a signed-in visitor with no organization to /create-org", () => {
    expect(
      resolveDashboardAccess({ hasSession: true, organizations: [] }),
    ).toEqual({ action: "redirect", to: "/create-org" });
  });

  it("renders the session's active organization", () => {
    expect(
      resolveDashboardAccess({
        hasSession: true,
        activeOrganizationId: BETA.id,
        organizations: [ACME, BETA],
      }),
    ).toEqual({ action: "allow", organization: BETA });
  });

  it("falls back to the first membership when no organization is active", () => {
    expect(
      resolveDashboardAccess({
        hasSession: true,
        activeOrganizationId: null,
        organizations: [ACME, BETA],
      }),
    ).toEqual({ action: "allow", organization: ACME });
  });

  it("falls back rather than bouncing when the active id is stale", () => {
    // The org was left or deleted; the session row still names it. The user
    // DOES have an organization, so /create-org would be the wrong answer.
    expect(
      resolveDashboardAccess({
        hasSession: true,
        activeOrganizationId: "org_deleted",
        organizations: [ACME],
      }),
    ).toEqual({ action: "allow", organization: ACME });
  });
});

describe("resolveCreateOrgAccess", () => {
  it("sends a signed-out visitor to /login", () => {
    expect(
      resolveCreateOrgAccess({ hasSession: false, organizationCount: 0 }),
    ).toEqual({ action: "redirect", to: "/login" });
  });

  it("lets an org-less signed-in visitor through", () => {
    expect(
      resolveCreateOrgAccess({ hasSession: true, organizationCount: 0 }),
    ).toEqual({ action: "allow" });
  });

  it("skips the step for a visitor who already has an organization", () => {
    expect(
      resolveCreateOrgAccess({ hasSession: true, organizationCount: 1 }),
    ).toEqual({ action: "redirect", to: "/" });
  });
});
