import { resolveCliCaller } from "@/src/lib/cli-auth";
import { EnvironmentService } from "@/src/services/environments";

/**
 * `GET /api/cli/environments` — how `hogsend publish --env staging` turns a
 * NAME into the environment id the publish intake is addressed by.
 *
 * The intake is `POST /api/publish/:environmentId` because an id is what a
 * `hspub_…` token is bound to, and CI holds ids. A human at a terminal holds a
 * name, and asking them to paste a uuid out of the dashboard to deploy would be
 * the worst part of the product. This endpoint is the translation, and it is
 * scoped by the session's organization, so the name resolution can never reach
 * a tenant the caller is not in.
 *
 * A READ, so any role may run it — including `member`, who cannot publish.
 * Withholding the list from them would make `hogsend publish` fail with "no
 * such environment" where the truth is "your role may not deploy", and the
 * intake already answers that precisely (`forbidden_role`).
 *
 * The stack's engine version travels with each row so the CLI can warn about a
 * mismatch BEFORE it spends a minute tarballing and uploading — the intake's
 * 409 stays the enforcement, this is only the courtesy.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const caller = await resolveCliCaller(request);
  if (!caller.ok) {
    const { status, error, message } = caller.refusal;
    return Response.json(
      { error, message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }

  const { organization } = caller.value;
  const { environments } = await new EnvironmentService().list({
    organizationId: organization.id,
  });

  return Response.json(
    {
      organization: { id: organization.id, name: organization.name },
      environments: environments.map((environment) => ({
        id: environment.id,
        name: environment.name,
        kind: environment.kind,
        stackStatus: environment.stack?.status ?? null,
        engineVersion: environment.stack?.engineVersion ?? null,
      })),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
