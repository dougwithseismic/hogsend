import { isUuid } from "@/src/lib/artifacts";
import {
  authorizePublishEnvironment,
  bearerToken,
  resolvePublishCredential,
} from "@/src/lib/publish-guards";
import { buildService, isTerminalBuildStatus } from "@/src/services/builds";
import { StackService } from "@/src/services/stacks";

/**
 * `GET /api/builds/:buildId` — what `hogsend publish` watches after the upload.
 *
 * The same dual credential as the intake (`lib/publish-guards.ts`): an
 * environment-bound `hspub_…`, or a person-bound `hscli_…` whose organization
 * owns the build's environment and whose human still holds a publishing role.
 * The two endpoints share one authorization module deliberately — a build a
 * caller could CREATE but not READ would be a bug that surfaces only as a CLI
 * that hangs.
 *
 * Two shape decisions worth stating:
 *
 *  - **A build outside the caller's scope is 404, not 403.** Unlike the intake
 *    — where the environment id is in the URL the caller typed — a build id is
 *    something this API handed out. Confirming that an id exists in a tenant
 *    the caller cannot see would turn the status endpoint into an existence
 *    oracle. The one 403 kept is `forbidden_role`: the caller demonstrably
 *    belongs to the organization, and "ask your admin" is actionable where
 *    "not found" would send them hunting for a typo.
 *  - **`logTail` is returned ONLY on a terminal status.** A running build's
 *    tail is a moving target that would be re-sent in full on every poll (up to
 *    64KB, every few seconds); the tail exists so a FAILED build can be
 *    diagnosed, and that is exactly when it stops moving. The dashboard's own
 *    build page is the surface for watching progress.
 */

// A status read, per request, never cached anywhere.
export const dynamic = "force-dynamic";

function fail(status: number, error: string, message: string): Response {
  return Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

const NOT_FOUND = {
  error: "build_not_found",
  message: "No such build, or it is not visible to this credential.",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ buildId: string }> },
): Promise<Response> {
  const { buildId } = await context.params;

  const token = bearerToken(request.headers);
  if (!token) {
    return fail(
      401,
      "missing_token",
      "Send a credential as `Authorization: Bearer hspub_…` (environment publish token) or `Bearer hscli_…` (a `hogsend login` session).",
    );
  }

  const credential = await resolvePublishCredential({ token });
  if (!credential) {
    return fail(
      401,
      "invalid_token",
      "That credential is not valid. Rotate the environment's publish token, or run `hogsend login` again.",
    );
  }

  if (!isUuid(buildId)) {
    return fail(404, NOT_FOUND.error, NOT_FOUND.message);
  }

  const build = await buildService.get({ buildId });
  if (!build) return fail(404, NOT_FOUND.error, NOT_FOUND.message);

  const authorized = await authorizePublishEnvironment({
    credential,
    environmentId: build.environmentId,
  });
  if (!authorized.ok) {
    if (authorized.refusal.error === "forbidden_role") {
      const { status, error, message } = authorized.refusal;
      return fail(status, error, message);
    }
    return fail(404, NOT_FOUND.error, NOT_FOUND.message);
  }

  const terminal = isTerminalBuildStatus(build.status);

  // The STACK's phase, alongside the build's. Under
  // `CLOUD_PROVISION_ON=first-publish` (PRD 15) a first publish spends its
  // opening minutes waiting for substrate that does not exist yet, and the
  // build status has nothing to say about it — `building` is true but useless,
  // and adding a build status for it would mean widening the single-flight
  // index's predicate for a phase that is not the build's at all. This is the
  // minimal honest answer: one more field, no schema change, and the CLI can
  // render "provisioning your instance" from the pair.
  //
  // Skipped once the build is TERMINAL: nothing renders a provisioning phase
  // for a build that has finished, and this is the endpoint `hogsend publish`
  // polls every three seconds — a read per poll that no caller reads is just
  // load on the busiest row in the table.
  const stack = terminal
    ? null
    : await new StackService().getByEnvironment({
        environmentId: build.environmentId,
      });

  return Response.json(
    {
      id: build.id,
      environmentId: build.environmentId,
      status: build.status,
      terminal,
      stack: stack ? { status: stack.status } : null,
      engineVersion: build.engineVersion,
      imageDigest: build.imageDigest,
      createdAt: build.createdAt.toISOString(),
      updatedAt: build.updatedAt.toISOString(),
      startedAt: build.startedAt?.toISOString() ?? null,
      finishedAt: build.finishedAt?.toISOString() ?? null,
      // The failure reason and the log travel together, and only once there is
      // nothing left to change about either.
      error: terminal ? build.error : null,
      logTail: terminal ? (build.logTail ?? "") : null,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
