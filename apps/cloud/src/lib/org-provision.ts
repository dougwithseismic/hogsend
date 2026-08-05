import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { organization as authOrganization } from "../db/schema/auth";
import { env } from "../env";
import { enqueueProvision as defaultEnqueueProvision } from "../pipeline/enqueue";
import type {
  CloudPlan,
  CloudRegion,
  OrgService,
  StackBirthStatus,
} from "../services/orgs";
import { orgService as defaultOrgService } from "../services/orgs";
import type { CloudAuth } from "./auth";
import { auth as defaultAuth } from "./auth";
import { isUsableSlug, SLUG_MAX_LENGTH } from "./hostnames";

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
  /**
   * The caller's request headers — the session Better Auth acts on. The
   * browser's create-org form passes these.
   */
  headers?: Headers;
  /**
   * HEADLESS alternative to {@link headers}: act as this user with no session
   * at all. `POST /api/cli/signup/verify` has just proven inbox ownership and
   * holds a user id, not a cookie, and minting a browser session purely to hand
   * it back to this function would be a credential nobody asked for.
   *
   * Better Auth supports exactly this shape — `createOrganization` accepts a
   * `body.userId` PROVIDED no headers are passed (it refuses a request that
   * carries headers but no session) — so the two inputs are mutually exclusive
   * rather than merely both-optional.
   */
  userId?: string;
  /**
   * Whether to ask for substrate now. Defaults to the deployment's policy
   * (`CLOUD_PROVISION_ON`, PRD 15): `signup` → true, `first-publish` → false,
   * in which case the stack is born `deferred` and the publish intake promotes
   * it. Passed explicitly only by tests and by a caller that has already
   * resolved the policy.
   */
  provision?: boolean;
}

export interface ProvisionOrganizationDeps {
  auth?: CloudAuth;
  orgService?: OrgService;
  /**
   * How the new stack's provisioning is queued. Injected so a test can assert
   * the enqueue happened without running infrastructure work.
   */
  enqueueProvision?: (stackId: string) => Promise<unknown>;
  /**
   * The compensating delete for the HEADLESS path. Better Auth's
   * `deleteOrganization` needs a session, which that path does not have, so the
   * rollback is a direct row delete (`member`/`invitation` cascade off it).
   */
  deleteOrganizationRow?: (organizationId: string) => Promise<unknown>;
}

export interface ProvisionOrganizationResult {
  organizationId: string;
  slug: string;
  environmentId: string;
  stackId: string;
  /**
   * What the stack was born as. `deferred` means nothing was enqueued and the
   * first publish is what starts it.
   */
  stackStatus: StackBirthStatus;
}

/**
 * URL-safe handle from a display name; never empty, and always usable as a
 * hostname label.
 *
 * The slug stopped being cosmetic the moment instances started answering at
 * `<slug>.hogsend.com`: it is now a DNS label sharing a zone with our own
 * marketing and tracking hosts. So it is held to `isUsableSlug` — length,
 * shape, no double hyphen, and not a reserved name. A name that reduces to
 * something unusable ("Docs", "A&B", "") gets a suffix rather than a refusal,
 * because the signup form never asked the user for a slug and cannot sensibly
 * reject them over one.
 */
export function slugifyOrgName(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

  // A name that reduces to nothing falls back to `org`, which is itself a
  // usable slug — so an unnamed org gets a clean handle, and a collision is
  // `createAuthOrganization`'s retry to resolve, exactly as before.
  const stem = base.length > 0 ? base : "org";
  if (isUsableSlug(stem)) return stem;

  // Reserved or too short to stand alone. Suffixing keeps the recognisable
  // stem and takes it out of the reserved namespace in one move.
  const suffixed = `${stem}-${randomBytes(3).toString("hex")}`.slice(
    0,
    SLUG_MAX_LENGTH,
  );
  return isUsableSlug(suffixed)
    ? suffixed
    : `org-${randomBytes(3).toString("hex")}`;
}

/**
 * WHO the organization is being created for, and HOW Better Auth is told.
 *
 * Both shapes carry the user id (the audit actor is the same question either
 * way); they differ only in what the Better Auth call may be handed.
 */
type OrgActor =
  | { kind: "session"; headers: Headers; userId: string }
  | { kind: "user"; userId: string };

/** The headless rollback's default: delete the Better Auth organization row. */
async function defaultDeleteOrganizationRow(
  organizationId: string,
): Promise<unknown> {
  return db
    .delete(authOrganization)
    .where(eq(authOrganization.id, organizationId));
}

async function resolveActor(
  auth: CloudAuth,
  input: ProvisionOrganizationInput,
): Promise<OrgActor> {
  if (input.headers) {
    const session = await auth.api.getSession({ headers: input.headers });
    if (!session) throw new Error("No signed-in user");
    return {
      kind: "session",
      headers: input.headers,
      userId: session.user.id,
    };
  }
  if (input.userId) return { kind: "user", userId: input.userId };
  throw new Error(
    "provisionOrganization needs either request `headers` (a signed-in session) or a `userId`",
  );
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
  actor: OrgActor,
  name: string,
): Promise<{ id: string; slug: string }> {
  const base = slugifyOrgName(name);
  const candidates = [base, `${base}-${randomBytes(3).toString("hex")}`];

  let lastError: unknown;
  for (const slug of candidates) {
    try {
      // Headers XOR userId, never both: Better Auth refuses a call that carries
      // headers without a session, so passing an empty `Headers` on the
      // headless path would turn every CLI signup into a 401.
      const created = await auth.api.createOrganization(
        actor.kind === "session"
          ? { body: { name, slug }, headers: actor.headers }
          : { body: { name, slug, userId: actor.userId } },
      );
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
  actor: OrgActor,
  organizationId: string,
  deleteRow: (organizationId: string) => Promise<unknown>,
): Promise<void> {
  try {
    if (actor.kind === "session") {
      await auth.api.deleteOrganization({
        body: { organizationId },
        headers: actor.headers,
      });
    } else {
      // No session to delete THROUGH. `member` and `invitation` cascade off
      // the organization row, so the delete is complete.
      await deleteRow(organizationId);
    }
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
  const deleteRow = deps.deleteOrganizationRow ?? defaultDeleteOrganizationRow;
  const { region, plan = "trial" } = input;
  const name = input.name.trim();

  // ONE policy for both front doors — see `CLOUD_PROVISION_ON` in `env.ts`.
  // `??` guards the `SKIP_ENV_VALIDATION=true` build, where t3-env hands back
  // raw process.env and the schema default is not applied.
  const provision =
    input.provision ?? (env.CLOUD_PROVISION_ON ?? "first-publish") === "signup";
  const stackStatus: StackBirthStatus = provision ? "requested" : "deferred";

  const actor = await resolveActor(auth, input);
  const created = await createAuthOrganization(auth, actor, name);

  try {
    const trio = await orgService.create({
      // Better Auth's id IS the tenant id — the mirror is keyed by it.
      id: created.id,
      name,
      region,
      plan,
      actor: actor.userId,
      stackStatus,
    });

    // PRD 04 EARS: "WHEN an organization is created, the system SHALL enqueue
    // provisioning without operator action." AFTER the trio commits, and
    // best-effort: the signup has succeeded by now, and a queue that is
    // momentarily unreachable is an operator retry, not a failed signup that
    // rolls back the user's organization.
    //
    // PRD 15 narrows WHEN that clause applies: under `first-publish` the stack
    // is `deferred` and there is nothing to enqueue — the intake enqueues on
    // the first upload instead. Skipping it here is the whole point; a queued
    // `deferred` stack would provision the thing the policy exists to defer.
    if (provision) {
      try {
        await enqueue(trio.stack.id);
      } catch (error) {
        console.error(
          `[cloud] Could not enqueue provisioning for stack ${trio.stack.id}:`,
          error,
        );
      }
    }

    return {
      organizationId: created.id,
      slug: created.slug,
      environmentId: trio.environment.id,
      stackId: trio.stack.id,
      stackStatus,
    };
  } catch (error) {
    await deleteAuthOrganization(auth, actor, created.id, deleteRow);
    throw error;
  }
}
