import { z } from "zod";
import type { CloudDb } from "../db";
import { CloudServiceError, NotFoundError } from "../services/errors";
import type { HogsendDomains } from "../services/ses-domains";
import { createHogsendDomains } from "../services/ses-domains";
import type { SesClient } from "../ses/contract";
import { SesError } from "../ses/types";
import { type RelayCaller, resolveRelayCaller } from "./email-relay";
import { consumeRateLimit } from "./rate-limit";
import { fail } from "./route-response";

/**
 * THE DOMAIN ENDPOINTS (PRD 07 task 4).
 *
 * A tenant instance has no AWS access — that is the entire reason the relay
 * exists (DECISIONS §3.5) — so `plugin-hogsend`'s `domains` capability reaches
 * SES through here, over the SAME bearer relay token the send wire uses. There
 * is deliberately no second auth path: `resolveRelayCaller` is the one place
 * that decides who is calling and which environment they are, and the
 * environment is what determines the SES tenancy. A request body may not name
 * its own environment, so the schemas are STRICT.
 *
 * Everything the endpoints DO lives in `services/ses-domains.ts`; the four
 * route files are three lines each, for the reason `email-relay.ts` gives.
 */

/**
 * Domain calls per environment per minute.
 *
 * Far below the send relay's, because these are not a traffic path: an operator
 * adds a domain once and Studio polls its status while the DNS propagates. The
 * limit exists because `create` on an unknown domain GENERATES A 2048-BIT RSA
 * KEYPAIR before it reaches SES — a leaked token could otherwise turn this
 * endpoint into a CPU amplifier, and AWS's own `CreateEmailIdentity` quota is
 * small enough that a flood would take the whole account's identity management
 * down with it.
 */
export const EMAIL_DOMAINS_BURST_LIMIT = 60;
export const EMAIL_DOMAINS_WINDOW_MS = 60_000;

/** Keyed on the ENVIRONMENT, like the relay's — the caller is an instance. */
export function emailDomainsBucket(environmentId: string): string {
  return `email_domains:${environmentId}`;
}

/** A domain name is an identifier; a request that carries one is tiny. */
const MAX_REQUEST_BYTES = 8 * 1024;

const domainSchema = z.string().trim().min(3).max(253);

const domainBodySchema = z.strictObject({ domain: domainSchema });

const returnPathBodySchema = z.strictObject({
  domain: domainSchema,
  enabled: z.boolean(),
});

export interface EmailDomainsDeps {
  db?: CloudDb;
  /** Defaults to the process-wide client for the environment's region. */
  ses?: SesClient;
  now?: Date;
}

/** `GET /api/email/domains?domain=…` — status, or `null` when SES has none. */
export async function handleDomainGet(
  request: Request,
  deps: EmailDomainsDeps = {},
): Promise<Response> {
  return withCaller(request, deps, async (domains) => {
    const domain = new URL(request.url).searchParams.get("domain")?.trim();
    const parsed = domainSchema.safeParse(domain ?? "");
    if (!parsed.success) return missingDomain();
    return json(200, { status: await domains.get(parsed.data) });
  });
}

/** `POST /api/email/domains` — register the domain. Idempotent. */
export async function handleDomainCreate(
  request: Request,
  deps: EmailDomainsDeps = {},
): Promise<Response> {
  return withCaller(request, deps, async (domains) => {
    const body = await readBody(request, domainBodySchema);
    if (!body.ok) return body.response;
    return json(200, { status: await domains.create(body.value.domain) });
  });
}

/** `POST /api/email/domains/verify` — re-read the status from SES. */
export async function handleDomainVerify(
  request: Request,
  deps: EmailDomainsDeps = {},
): Promise<Response> {
  return withCaller(request, deps, async (domains) => {
    const body = await readBody(request, domainBodySchema);
    if (!body.ok) return body.response;
    return json(200, { status: await domains.verify(body.value.domain) });
  });
}

/** `POST /api/email/domains/return-path` — the advanced toggle, both ways. */
export async function handleDomainReturnPath(
  request: Request,
  deps: EmailDomainsDeps = {},
): Promise<Response> {
  return withCaller(request, deps, async (domains) => {
    const body = await readBody(request, returnPathBodySchema);
    if (!body.ok) return body.response;
    const result = await domains.setReturnPath({
      domain: body.value.domain,
      enabled: body.value.enabled,
    });
    return json(200, result);
  });
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/**
 * auth → rate limit → run, and one translation of every failure the service
 * can raise.
 *
 * The order mirrors the relay's for the same reason: nothing below is reachable
 * anonymously, and the limiter is charged before ANY caller-controlled input is
 * inspected, so a flood of malformed requests is bounded too.
 */
async function withCaller(
  request: Request,
  deps: EmailDomainsDeps,
  run: (domains: HogsendDomains, caller: RelayCaller) => Promise<Response>,
): Promise<Response> {
  const auth = await resolveRelayCaller(request, {
    ...(deps.db ? { db: deps.db } : {}),
  });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  const decision = await consumeRateLimit({
    bucket: emailDomainsBucket(caller.environmentId),
    limit: EMAIL_DOMAINS_BURST_LIMIT,
    windowMs: EMAIL_DOMAINS_WINDOW_MS,
    now: deps.now ?? new Date(),
    ...(deps.db ? { db: deps.db } : {}),
  });
  if (!decision.allowed) {
    return fail(
      429,
      "rate_limited",
      `This environment may make ${decision.limit} domain requests per minute. Retry after the window rolls.`,
      { "retry-after": String(decision.retryAfterSeconds) },
    );
  }

  const domains = createHogsendDomains(
    { environmentId: caller.environmentId, actor: `relay:${caller.tokenId}` },
    {
      ...(deps.db ? { db: deps.db } : {}),
      ...(deps.ses ? { ses: deps.ses } : {}),
    },
  );

  try {
    return await run(domains, caller);
  } catch (error) {
    return failureResponse(error, caller);
  }
}

function failureResponse(error: unknown, caller: RelayCaller): Response {
  // A rule the caller can act on: an unparseable domain, an environment with no
  // Hogsend Email tenancy, an identity that is not there. The `code` travels
  // verbatim so the plugin and Studio can branch on it.
  if (error instanceof NotFoundError) {
    return fail(404, error.code, error.message);
  }
  if (error instanceof CloudServiceError) {
    return fail(400, error.code, error.message);
  }

  if (error instanceof SesError) {
    // Same posture as the send relay: a 4xx from SES is the caller's problem
    // and is never retried, a throttle or a 5xx invites one.
    if (error.retryable) {
      return fail(
        503,
        "domains_unavailable",
        "SES could not answer right now. Nothing was changed, so a retry is safe.",
        { "retry-after": "5" },
      );
    }
    if (error.kind === "invalid") {
      return fail(400, "domain_rejected", error.detail ?? error.message);
    }
    if (error.kind === "not_found") {
      return fail(404, "not_found", error.detail ?? error.message);
    }
    return fail(502, "domains_failed", error.detail ?? error.message);
  }

  console.error(
    `[cloud:email-domains] unexpected failure for environment ${caller.environmentId}:`,
    error,
  );
  return fail(
    502,
    "domains_failed",
    "The domains request could not be completed.",
  );
}

function missingDomain(): Response {
  return fail(
    400,
    "invalid_request",
    "Name the sending domain with a `domain` query parameter.",
  );
}

type BodyRead<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * The body, capped by BOTH the declared length and the metered read — the same
 * posture the relay holds, at a much smaller size because everything these
 * endpoints accept is an identifier.
 */
async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<BodyRead<T>> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return { ok: false, response: tooLarge() };
  }
  if (!request.body) {
    return { ok: false, response: invalid("The request has no body.") };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { ok: false, response: tooLarge() };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      response: invalid("The request body could not be read."),
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks, total).toString("utf-8"));
  } catch {
    return { ok: false, response: invalid("The request body is not JSON.") };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: json(
        400,
        {
          error: "invalid_request",
          message:
            "The request body is not a valid domains request. Name the `domain`, and nothing else.",
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { "cache-control": "no-store" },
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

function tooLarge(): Response {
  return fail(
    413,
    "payload_too_large",
    `A domains request may be at most ${MAX_REQUEST_BYTES} bytes.`,
  );
}

function invalid(message: string): Response {
  return fail(400, "invalid_request", message);
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
