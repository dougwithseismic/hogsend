import { resolveCliCaller } from "@/src/lib/cli-auth";

/**
 * `GET /api/cli/session` — what `hogsend whoami` reads.
 *
 * The device flow hands the CLI a token and nothing else: the poll response
 * carries ids, not names, because at approval time the CLI has no credential to
 * be told anything WITH. This is where a stored session becomes a sentence a
 * human can read — "you are doug@… in Acme on cloud.hogsend.com" — and it is a
 * server endpoint rather than a claim baked into the credentials file because
 * the answer can change after login: an org rename, a role change, a removal.
 *
 * It is also the fail-closed probe. A revoked session answers 401 here for the
 * same reason it does at the publish intake, so `hogsend whoami` is a truthful
 * "can this machine still reach the cloud", not a read of a local file.
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

  const { session, user, organization, role } = caller.value;

  return Response.json(
    {
      session: {
        id: session.id,
        label: session.label,
        // The last four characters of the secret, which is what the dashboard
        // list shows too. Never the token, never its hash.
        last4: session.last4,
        createdAt: session.createdAt.toISOString(),
        lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
      },
      user,
      organization,
      role,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
