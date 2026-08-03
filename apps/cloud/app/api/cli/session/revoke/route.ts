import { resolveCliSession } from "@/src/lib/cli-auth";
import { CliSessionService } from "@/src/services/cli-sessions";

/**
 * `POST /api/cli/session/revoke` — the server half of `hogsend logout`.
 *
 * A session may revoke ITSELF and nothing else. There is no body, no session
 * id, no scope: the credential in the Authorization header IS the subject, so
 * this endpoint cannot be pointed at a colleague's machine no matter what is
 * sent to it. Retiring somebody ELSE's session is an operator action and lives
 * where operator actions live — Settings → CLI sessions, behind a dashboard
 * session and a role check (`lib/cli-sessions-ops.ts`).
 *
 * Deliberately NOT membership-checked (unlike `GET /api/cli/session`). Cutting
 * your own machine off has to keep working after you have been removed from the
 * organization — that is exactly when you most want the local credential gone —
 * so this needs a live session and nothing more.
 *
 * Idempotent: the service's `revoked_at IS NULL` guard means a second logout
 * does not move the timestamp. It cannot be observed here anyway, because a
 * revoked token no longer verifies — a repeat logout is a 401, and the CLI
 * treats that as "already done" and deletes the local entry regardless.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const resolved = await resolveCliSession(request);
  if (!resolved.ok) {
    const { status, error, message } = resolved.refusal;
    return Response.json(
      { error, message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }

  const session = resolved.value;
  const summary = await new CliSessionService().revoke({
    sessionId: session.id,
    organizationId: session.organizationId,
    // The machine holding the credential is the actor; there is no dashboard
    // user behind this call to attribute it to.
    actor: session.userId,
  });

  return Response.json(
    {
      revoked: true,
      sessionId: summary.id,
      revokedAt: summary.revokedAt?.toISOString() ?? null,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
