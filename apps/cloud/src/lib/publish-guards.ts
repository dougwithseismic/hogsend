import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, stacks } from "../db/schema";
import { member } from "../db/schema/auth";
import {
  CliSessionService,
  type CliSessionSummary,
  isCliToken,
} from "../services/cli-sessions";
import { PublishTokenService } from "../services/publish-tokens";
import { isUuid } from "./artifacts";
import { roleList } from "./org-members";

/**
 * Everything `POST /api/publish/:environmentId` and `GET /api/builds/:id` must
 * decide before they will look at a body: WHO is calling, WHETHER they may
 * touch this environment, and whether the code they are shipping is even
 * compatible with what the stack is running.
 *
 * It is one module because the two endpoints must agree — a build a caller
 * could create but not read (or vice versa) would be a bug that only shows up
 * in the CLI's status loop.
 *
 * Two credentials, deliberately different in kind:
 *
 *  - **`hspub_…`** is bound to ONE ENVIRONMENT. It carries its own
 *    authorization: holding it IS the permission, which is what makes it usable
 *    from CI where no human is present. It is checked against nothing else.
 *  - **`hscli_…`** is bound to a PERSON in an ORGANIZATION and carries NO
 *    authority of its own. Every use re-reads the membership row, so a member
 *    who was removed, demoted, or had their session revoked stops being able to
 *    publish at the next request — with no rotation, no sweep, and nothing to
 *    remember to do. That is the whole reason the session row has no scope
 *    column: a stored permission is a permission that can go stale.
 */

/**
 * The roles that may ship code into an organization's runtime.
 *
 * `member` — the default role Better Auth gives an invitee — is deliberately
 * NOT here: reading a dashboard and deploying to production are different
 * powers. `developer` is listed because it is the role this product means by
 * "may publish, may not administer"; it is not one of Better Auth's defaults
 * yet, and listing it now means adding it later is a role definition rather
 * than a hunt through authorization code.
 */
export const PUBLISH_ROLES = ["owner", "admin", "developer"] as const;

export function canPublish(role: string | null | undefined): boolean {
  const roles: readonly string[] = PUBLISH_ROLES;
  return roleList(role).some((value) => roles.includes(value));
}

/** `Authorization: Bearer <token>` — the only credential transport here. */
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export function bearerToken(headers: Headers): string | null {
  return BEARER_PATTERN.exec(headers.get("authorization") ?? "")?.[1] ?? null;
}

export type PublishCredential =
  | { kind: "publish_token"; tokenId: string; environmentId: string }
  | { kind: "cli_session"; session: CliSessionSummary };

/** A refusal, in the exact shape the route answers with. */
export interface PublishRefusal {
  status: number;
  error: string;
  message: string;
}

export type PublishAuthorization =
  | {
      ok: true;
      /** Who to file the build's audit rows under. */
      actor: string;
      organizationId: string;
      environmentId: string;
    }
  | { ok: false; refusal: PublishRefusal };

export interface PublishGuardDeps {
  db?: CloudDb;
}

/**
 * Which credential this is, or null.
 *
 * A revoked CLI session answers null — the same as an unknown token — because
 * every caller's correct response is identical and one branch cannot be
 * forgotten the way two can (`CliSessionService.verify`).
 */
export async function resolvePublishCredential(
  input: { token: string },
  deps: PublishGuardDeps = {},
): Promise<PublishCredential | null> {
  const db = deps.db ?? defaultDb;

  if (isCliToken(input.token)) {
    const verified = await new CliSessionService(db).verify({
      token: input.token,
    });
    return verified.found
      ? { kind: "cli_session", session: verified.session }
      : null;
  }

  const verified = await new PublishTokenService(db).verify({
    token: input.token,
  });
  return verified.found
    ? {
        kind: "publish_token",
        tokenId: verified.tokenId,
        environmentId: verified.environmentId,
      }
    : null;
}

/**
 * May this credential act on this environment?
 *
 * The two kinds fail in deliberately different ways:
 *  - a publish token aimed elsewhere is 403 `forbidden_environment` — it is a
 *    real credential used against a target it does not own, and saying so is
 *    not a leak, because the holder already knows their own environment id;
 *  - a CLI session aimed at another tenant is 403 `forbidden_organization`,
 *    and a session whose human is no longer allowed to publish is 403
 *    `forbidden_role`. The distinction matters at the terminal: one is "you are
 *    pointed at the wrong place", the other is "ask your admin".
 *
 * A successful CLI authorization also stamps `last_used_at`, throttled — see
 * `CLI_SESSION_TOUCH_STALE_MS`.
 */
export async function authorizePublishEnvironment(
  input: { credential: PublishCredential; environmentId: string },
  deps: PublishGuardDeps = {},
): Promise<PublishAuthorization> {
  const db = deps.db ?? defaultDb;
  const { credential, environmentId } = input;

  if (!isUuid(environmentId)) {
    return {
      ok: false,
      refusal: {
        status: 403,
        error: "forbidden_environment",
        message: "That credential does not grant access to this environment.",
      },
    };
  }

  const [environment] = await db
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);

  if (credential.kind === "publish_token") {
    if (credential.environmentId !== environmentId || !environment) {
      return {
        ok: false,
        refusal: {
          status: 403,
          error: "forbidden_environment",
          message: "That publish token belongs to a different environment.",
        },
      };
    }
    return {
      ok: true,
      actor: `publish_token:${credential.tokenId}`,
      organizationId: environment.organizationId,
      environmentId,
    };
  }

  const { session } = credential;
  // A missing environment answers the same as a foreign one: a CLI session
  // holder must not be able to probe which environment ids exist.
  if (!environment || environment.organizationId !== session.organizationId) {
    return {
      ok: false,
      refusal: {
        status: 403,
        error: "forbidden_organization",
        message:
          "That CLI session belongs to a different organization. Run `hogsend login` against the right one.",
      },
    };
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, session.organizationId),
        eq(member.userId, session.userId),
      ),
    )
    .limit(1);

  if (!membership || !canPublish(membership.role)) {
    return {
      ok: false,
      refusal: {
        status: 403,
        error: "forbidden_role",
        message: `Publishing needs one of these roles in this organization: ${PUBLISH_ROLES.join(", ")}.`,
      },
    };
  }

  await new CliSessionService(db).touch({ sessionId: session.id });

  return {
    ok: true,
    actor: `cli_session:${session.id}`,
    organizationId: session.organizationId,
    environmentId,
  };
}

/**
 * The engine-version gate.
 *
 * A stack records the engine version it is RUNNING. A tarball built against a
 * different one is not a deploy, it is a migration: the engine owns database
 * schema and durable-workflow shapes, so shipping a mismatched version by
 * accident is how a tenant's in-flight journeys break. The refusal is therefore
 * the default, and `allowUpgrade` in the manifest is the caller stating they
 * meant it (`hogsend publish --allow-upgrade`).
 *
 * A stack with NO recorded version is not refused — it has never deployed, so
 * there is nothing to disagree with.
 */
export interface EngineVersionVerdict {
  ok: boolean;
  stackVersion: string | null;
  manifestVersion: string;
}

export async function checkEngineVersion(
  input: {
    environmentId: string;
    manifestVersion: string;
    allowUpgrade?: boolean;
  },
  deps: PublishGuardDeps = {},
): Promise<EngineVersionVerdict> {
  const db = deps.db ?? defaultDb;

  const [stack] = await db
    .select({ engineVersion: stacks.engineVersion })
    .from(stacks)
    .where(eq(stacks.environmentId, input.environmentId))
    .limit(1);

  const stackVersion = stack?.engineVersion ?? null;
  const ok =
    input.allowUpgrade === true ||
    stackVersion === null ||
    stackVersion === input.manifestVersion;

  return { ok, stackVersion, manifestVersion: input.manifestVersion };
}
