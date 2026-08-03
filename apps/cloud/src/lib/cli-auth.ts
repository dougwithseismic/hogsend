import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { member, organization, user } from "../db/schema/auth";
import {
  CliSessionService,
  type CliSessionSummary,
  isCliToken,
} from "../services/cli-sessions";
import { bearerToken } from "./publish-guards";

/**
 * What the CLI-session endpoints (`/api/cli/session`, `/api/cli/session/revoke`,
 * `/api/cli/environments`) must decide before they answer anything.
 *
 * `publish-guards.ts` is the same idea for the two endpoints that accept EITHER
 * an environment-bound `hspub_…` or a person-bound `hscli_…`. This module is
 * the narrower half: the endpoints below are ABOUT the person's session, so an
 * `hspub_…` is not a weaker credential here, it is the wrong kind of thing —
 * a publish token names no user and belongs to no organization membership.
 * It is refused as invalid rather than resolved.
 *
 * The one law carried over verbatim from `cli-sessions.ts`: a session carries
 * NO authority of its own. `whoami` and the environment list both RE-READ the
 * membership row, so a human removed from the organization stops being able to
 * see it at the next request — no rotation, nothing to sweep. Revoking is the
 * deliberate exception: cutting your own machine off must keep working even
 * after you have been removed, so it needs only a live session.
 */

/** A refusal in the exact shape the routes answer with. */
export interface CliAuthRefusal {
  status: number;
  error: string;
  message: string;
}

export interface CliCaller {
  session: CliSessionSummary;
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; slug: string | null };
  /** The membership role, re-read on THIS request. */
  role: string;
}

export type CliAuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: CliAuthRefusal };

export interface CliAuthDeps {
  db?: CloudDb;
}

const MISSING: CliAuthRefusal = {
  status: 401,
  error: "missing_token",
  message:
    "Send a CLI session as `Authorization: Bearer hscli_…`. Run `hogsend login` to get one.",
};

const INVALID: CliAuthRefusal = {
  status: 401,
  error: "invalid_token",
  message:
    "That CLI session is not valid or has been revoked. Run `hogsend login` again.",
};

/**
 * The session behind the request's bearer, or a refusal.
 *
 * An absent, malformed, non-`hscli_`, unknown or REVOKED credential all answer
 * 401 — `CliSessionService.verify` already folds revoked into not-found for
 * exactly this reason: every caller's correct response is identical, and one
 * branch cannot be forgotten the way two can.
 */
export async function resolveCliSession(
  request: Request,
  deps: CliAuthDeps = {},
): Promise<CliAuthResult<CliSessionSummary>> {
  const token = bearerToken(request.headers);
  if (!token) return { ok: false, refusal: MISSING };
  if (!isCliToken(token)) return { ok: false, refusal: INVALID };

  const db = deps.db ?? defaultDb;
  const verified = await new CliSessionService(db).verify({ token });
  if (!verified.found) return { ok: false, refusal: INVALID };
  return { ok: true, value: verified.session };
}

/**
 * The session PLUS the human and organization it names, with the membership
 * re-read from the database.
 *
 * A session whose human is no longer in the organization is 403
 * `forbidden_organization`, not 401: the credential is real and the caller
 * already knows which org they logged into, so "you are no longer a member" is
 * the actionable answer and leaks nothing they did not have.
 *
 * A successful resolve stamps `last_used_at` (throttled by the service), so
 * "which machines can still reach this org" stays answerable from the
 * dashboard's Settings → CLI sessions list.
 */
export async function resolveCliCaller(
  request: Request,
  deps: CliAuthDeps = {},
): Promise<CliAuthResult<CliCaller>> {
  const db = deps.db ?? defaultDb;
  const resolved = await resolveCliSession(request, deps);
  if (!resolved.ok) return resolved;
  const session = resolved.value;

  const [row] = await db
    .select({
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.organizationId, session.organizationId),
        eq(member.userId, session.userId),
      ),
    )
    .limit(1);

  if (!row) {
    return {
      ok: false,
      refusal: {
        status: 403,
        error: "forbidden_organization",
        message:
          "This CLI session's user is no longer a member of that organization. Run `hogsend login` again.",
      },
    };
  }

  await new CliSessionService(db).touch({ sessionId: session.id });

  return {
    ok: true,
    value: {
      session,
      user: { id: row.userId, email: row.userEmail, name: row.userName },
      organization: {
        id: row.organizationId,
        name: row.organizationName,
        slug: row.organizationSlug,
      },
      role: row.role,
    },
  };
}
