import { resolveCliCaller } from "@/src/lib/cli-auth";
import { NotPermittedError } from "@/src/lib/org-members";
import {
  revealIngestCredentials,
  TenantAccessUnavailableError,
} from "@/src/lib/tenant-access";
import { NotFoundError } from "@/src/services/errors";

/**
 * `GET /api/cli/environments/:environmentId/credentials` — what
 * `hogsend env pull` reads to point a repo at the instance the customer signed
 * up for on the web.
 *
 * Addressed by environment ID, like the publish intake, and for the same
 * reason: an id is the stable handle, and the CLI already turns the human's
 * `--env <name>` into one through `GET /api/cli/environments`. Nesting it under
 * that route rather than inventing a sibling keeps the two reads obviously the
 * same resource.
 *
 * **This is not the environments list, and it is not gated like it.** That
 * endpoint is a READ any role may run, because withholding a NAME→ID mapping
 * would only make the next call fail with a misleading message. This one
 * releases a live credential: reading the API key is administering an
 * environment, not browsing it, so it passes the operator-role gate that
 * `lib/tenant-access.ts` applies to the dashboard's reveal — a plain `member`
 * is refused, and told it is their role rather than told the environment does
 * not exist.
 *
 * Every rule it applies is `revealIngestCredentials`', not a copy: tenancy
 * scope, operator role, stack readiness, decrypt, audit. The ONLY thing this
 * file decides is who the caller is (a `hogsend login` session rather than a
 * browser one) and how each refusal renders on the wire.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function fail(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status, headers: NO_STORE });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ environmentId: string }> },
): Promise<Response> {
  const caller = await resolveCliCaller(request);
  if (!caller.ok) {
    const { status, error, message } = caller.refusal;
    return fail(status, error, message);
  }

  const { environmentId } = await context.params;

  try {
    const revealed = await revealIngestCredentials(
      {
        organizationId: caller.value.organization.id,
        userId: caller.value.user.id,
        role: caller.value.role,
      },
      { environmentId },
    );
    return Response.json(
      {
        environmentId,
        apiUrl: revealed.apiUrl,
        apiKey: revealed.apiKey,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof NotPermittedError) {
      // Deliberately NOT the message `assertCanOperateEnvironments` throws:
      // that one talks about suspending and destroying, and a customer told
      // that after asking for their API key would reasonably think they had hit
      // the wrong command.
      return fail(
        403,
        "forbidden_role_credentials",
        `Your role in ${caller.value.organization.name} (${caller.value.role}) cannot read this environment's credentials. Reading an API key administers the environment, so it is owner- and admin-only.`,
      );
    }
    if (error instanceof NotFoundError) {
      // Scoped in the query, so a foreign id is indistinguishable from one that
      // never existed — which is the point.
      return fail(
        404,
        "not_found",
        `No environment "${environmentId}" in ${caller.value.organization.name}.`,
      );
    }
    if (error instanceof TenantAccessUnavailableError) {
      return fail(409, error.code, error.message);
    }
    throw error;
  }
}
