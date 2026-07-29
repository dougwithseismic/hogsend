import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments } from "../db/schema";
import {
  type BuildRow,
  BuildService,
  type BuildSummary,
} from "../services/builds";
import { NotFoundError } from "../services/errors";
import {
  type IssuePublishTokenResult,
  PublishTokenService,
  type PublishTokenSummary,
} from "../services/publish-tokens";
import { canOperateEnvironments } from "./environment-ops";
import type { OrgMembersDeps } from "./org-members";
import { NotPermittedError, readMemberContext } from "./org-members";

/**
 * What the build surfaces read, and the one mutation they offer.
 *
 * The tenancy guard lives HERE, not in the pages, for the reason
 * `environment-detail.ts` states: a server component cannot be called from a
 * test with a session, so the rule that turns another tenant's environment into
 * a 404 has to be provable without a Next request. Every read below resolves
 * the caller's organization from their membership and scopes to it; a
 * cross-tenant id and a made-up one are both `null`.
 *
 * `rotatePublishToken` is the only WRITE, and it re-checks the role. A publish
 * token is a credential that can deploy code into a tenant's runtime, so it is
 * gated the same way suspend/destroy are: owner or admin, never a plain member.
 */

/** How many builds the environment page's history shows. */
export const BUILD_HISTORY_LENGTH = 10;

export interface BuildsView {
  builds: BuildSummary[];
  /**
   * The token card: `last4` and its dates, never a credential. Always present —
   * `readBuildsView` mints the row if the environment has none.
   */
  token: PublishTokenSummary;
  /** Whether this caller may rotate the token. */
  canRotate: boolean;
}

export interface BuildViewDeps extends OrgMembersDeps {
  db?: CloudDb;
}

/** The environment ids of the caller's own organization, as a guard. */
async function assertOwnEnvironment(
  headers: Headers,
  environmentId: string,
  deps: BuildViewDeps,
): Promise<{ organizationId: string; role: string; userId: string }> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);

  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Environment", environmentId);
  return context;
}

/**
 * The build history and publish-token card for one environment.
 *
 * `ensure` runs here rather than in a migration: it mints the token row for
 * environments that predate publish tokens, on the first read, with no operator
 * step. It never returns a secret — see `PublishTokenService.ensure`.
 */
export async function readBuildsView(
  headers: Headers,
  input: { environmentId: string },
  deps: BuildViewDeps = {},
): Promise<BuildsView | null> {
  const db = deps.db ?? defaultDb;

  let context: { role: string };
  try {
    context = await assertOwnEnvironment(headers, input.environmentId, deps);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }

  const builds = new BuildService(db);
  const tokens = new PublishTokenService(db);

  const [history, token] = await Promise.all([
    builds.list({
      environmentId: input.environmentId,
      limit: BUILD_HISTORY_LENGTH,
    }),
    tokens.ensure({ environmentId: input.environmentId }),
  ]);

  return {
    builds: history.builds,
    token: token.summary,
    canRotate: canOperateEnvironments(context.role),
  };
}

/** One build in full, scoped to the caller's organization. */
export async function readBuildDetail(
  headers: Headers,
  input: { environmentId: string; buildId: string },
  deps: BuildViewDeps = {},
): Promise<BuildRow | null> {
  const db = deps.db ?? defaultDb;

  try {
    await assertOwnEnvironment(headers, input.environmentId, deps);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }

  return new BuildService(db).get({
    buildId: input.buildId,
    environmentId: input.environmentId,
  });
}

/**
 * Issue a new publish token for the caller's own environment, invalidating the
 * previous one. The returned secret is the ONLY copy — the action renders it
 * once and it is never readable again.
 */
export async function rotatePublishToken(
  headers: Headers,
  input: { environmentId: string },
  deps: BuildViewDeps = {},
): Promise<IssuePublishTokenResult> {
  const db = deps.db ?? defaultDb;
  const context = await assertOwnEnvironment(
    headers,
    input.environmentId,
    deps,
  );
  if (!canOperateEnvironments(context.role)) {
    throw new NotPermittedError(
      "Only an owner or admin can rotate a publish token.",
    );
  }

  const tokens = new PublishTokenService(db);
  // `ensure` first so a pre-publish-token environment can be rotated in one
  // click rather than refusing with "there is nothing to rotate".
  await tokens.ensure({ environmentId: input.environmentId });
  return tokens.rotate({
    environmentId: input.environmentId,
    actor: context.userId,
  });
}
