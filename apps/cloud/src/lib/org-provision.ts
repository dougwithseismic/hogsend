import { randomBytes } from "node:crypto";
import { enqueueProvision as defaultEnqueueProvision } from "../pipeline/enqueue";
import type { CloudPlan, CloudRegion, OrgService } from "../services/orgs";
import { orgService as defaultOrgService } from "../services/orgs";
import type { CloudAuth } from "./auth";
import { auth as defaultAuth } from "./auth";

/**
 * Creating an organization spans TWO stores that have no shared transaction:
 * Better Auth's `organization` + `member` rows (which own identity and
 * membership) and the control plane's `cloud.organizations` trio (mirror +
 * production environment + `requested` stack).
 *
 * Order is forced: `OrgService.create` keys the mirror BY Better Auth's
 * organization id, so Better Auth must go first. That leaves exactly one
 * failure to handle — the trio refusing after the Better Auth org exists (a
 * region with no accepting cell is the ordinary case) — and this module handles
 * it with a compensating DELETE, so a refused signup leaves the user with no
 * membership at all rather than an organization the dashboard cannot render.
 *
 * The trio itself is atomic inside its own transaction, so there is no
 * half-created tenant to compensate for: it is all-or-nothing before we get
 * here.
 */

/** Better Auth's code when a slug is already taken. */
const SLUG_TAKEN_CODE = "ORGANIZATION_ALREADY_EXISTS";

export interface ProvisionOrganizationInput {
  name: string;
  region: CloudRegion;
  /** Defaults to `trial`; paid plans arrive with billing. */
  plan?: CloudPlan;
  /** The caller's request headers — the session Better Auth acts on. */
  headers: Headers;
}

export interface ProvisionOrganizationDeps {
  auth?: CloudAuth;
  orgService?: OrgService;
  /**
   * How the new stack's provisioning is queued. Injected so a test can assert
   * the enqueue happened without running infrastructure work.
   */
  enqueueProvision?: (stackId: string) => Promise<unknown>;
}

export interface ProvisionOrganizationResult {
  organizationId: string;
  slug: string;
  environmentId: string;
  stackId: string;
}

/** URL-safe handle from a display name; never empty. */
export function slugifyOrgName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "org";
}

function isSlugTaken(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body = (error as { body?: { code?: unknown } }).body;
  return body?.code === SLUG_TAKEN_CODE;
}

/**
 * Create the Better Auth organization, retrying ONCE under a suffixed slug.
 *
 * Names collide often ("Acme"), and the slug is not something the signup form
 * asks for, so a taken slug must not be a dead end the user cannot act on.
 */
async function createAuthOrganization(
  auth: CloudAuth,
  headers: Headers,
  name: string,
): Promise<{ id: string; slug: string }> {
  const base = slugifyOrgName(name);
  const candidates = [base, `${base}-${randomBytes(3).toString("hex")}`];

  let lastError: unknown;
  for (const slug of candidates) {
    try {
      const created = await auth.api.createOrganization({
        body: { name, slug },
        headers,
      });
      if (!created) throw new Error("Better Auth returned no organization");
      return { id: created.id, slug };
    } catch (error) {
      if (!isSlugTaken(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Best-effort undo of the Better Auth organization. Its own failure is logged,
 * never thrown: the caller is already unwinding a real error and that one is
 * the one the user needs to read.
 */
async function deleteAuthOrganization(
  auth: CloudAuth,
  headers: Headers,
  organizationId: string,
): Promise<void> {
  try {
    await auth.api.deleteOrganization({ body: { organizationId }, headers });
  } catch (error) {
    console.error(
      `[cloud] Could not roll back organization ${organizationId}:`,
      error,
    );
  }
}

/**
 * THE org-creation path. `OrgService.create` is never called anywhere else —
 * doing so would produce a control-plane tenant with no Better Auth org, which
 * nobody could sign in to.
 */
export async function provisionOrganization(
  input: ProvisionOrganizationInput,
  deps: ProvisionOrganizationDeps = {},
): Promise<ProvisionOrganizationResult> {
  const auth = deps.auth ?? defaultAuth;
  const orgService = deps.orgService ?? defaultOrgService;
  const enqueue = deps.enqueueProvision ?? defaultEnqueueProvision;
  const { headers, region, plan = "trial" } = input;
  const name = input.name.trim();

  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("No signed-in user");

  const created = await createAuthOrganization(auth, headers, name);

  try {
    const trio = await orgService.create({
      // Better Auth's id IS the tenant id — the mirror is keyed by it.
      id: created.id,
      name,
      region,
      plan,
      actor: session.user.id,
    });

    // PRD 04 EARS: "WHEN an organization is created, the system SHALL enqueue
    // provisioning without operator action." AFTER the trio commits, and
    // best-effort: the signup has succeeded by now, and a queue that is
    // momentarily unreachable is an operator retry, not a failed signup that
    // rolls back the user's organization.
    try {
      await enqueue(trio.stack.id);
    } catch (error) {
      console.error(
        `[cloud] Could not enqueue provisioning for stack ${trio.stack.id}:`,
        error,
      );
    }

    return {
      organizationId: created.id,
      slug: created.slug,
      environmentId: trio.environment.id,
      stackId: trio.stack.id,
    };
  } catch (error) {
    await deleteAuthOrganization(auth, headers, created.id);
    throw error;
  }
}
