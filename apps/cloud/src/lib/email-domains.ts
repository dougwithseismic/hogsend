import { z } from "zod";
import type { CloudDb } from "../db";
import { CloudServiceError, NotFoundError } from "../services/errors";
import type { HogsendDomains } from "../services/ses-domains";
import {
  createHogsendDomains,
  DomainNotOwnedError,
} from "../services/ses-domains";
import type { HogsendInbound } from "../services/ses-inbound-domains";
import {
  createHogsendInbound,
  ForeignInboundMxError,
} from "../services/ses-inbound-domains";
import type { SesClient } from "../ses/contract";
import type { SesInboundClient } from "../ses/inbound/contract";
import { SesError } from "../ses/types";
import { type RelayCaller, resolveRelayCaller } from "./email-relay";
import type { InboundStore, MxLookup } from "./inbound-domains";
import { inboundMxOverridePhrase } from "./inbound-domains";
import { consumeRateLimit } from "./rate-limit";
import { fail } from "./route-response";
import { MAIL_FROM_LABEL_PATTERN } from "./sending-domains";

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
  /**
   * The subdomain the return path sits on — `notifications` gives
   * `notifications.acme.com`. Optional: omitting it keeps `send`, so a customer
   * who already published `send.<domain>` is unaffected.
   *
   * Validated HERE as well as in the service, so a bad label is a 400 before
   * anything reaches SES. `strictObject` means an unknown key is still a 400.
   */
  label: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      MAIL_FROM_LABEL_PATTERN,
      'must be one DNS label, e.g. "notifications" (lowercase letters, digits ' +
        "and hyphens, starting and ending alphanumeric, 63 characters or fewer)",
    )
    .optional(),
});

/** One DNS label, validated HERE so a bad one is a 400 before it reaches SES. */
const labelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    MAIL_FROM_LABEL_PATTERN,
    'must be one DNS label, e.g. "reply" (lowercase letters, digits and ' +
      "hyphens, starting and ending alphanumeric, 63 characters or fewer)",
  );

/**
 * The inbound toggle, both directions, as a DISCRIMINATED union.
 *
 * `enabled: false` accepts the domain and nothing else: a disable that carried
 * a forwarding address would read as though it configured one, and the two
 * requests do genuinely different things to an account-wide rule set.
 *
 * `forwardTo` is deliberately NOT format-checked here. One rule decides what a
 * forwarding address is and it is the service's (`FORWARD_ADDRESS_RE`), because
 * an address refused by two different rules would answer two different codes
 * for one broken configuration — and this one has to name the field that fixes
 * it. The bounds below are a payload cap, not a definition.
 */
const inboundBodySchema = z.discriminatedUnion("enabled", [
  z.strictObject({
    domain: domainSchema,
    enabled: z.literal(true),
    forwardTo: z.string().trim().min(1).max(320).optional(),
    label: labelSchema.optional(),
    /** The typed confirmation from `inboundMxOverridePhrase`. Compared
     * verbatim by the service; never interpreted here. */
    confirmMxReplacement: z.string().trim().min(1).max(256).optional(),
  }),
  z.strictObject({ domain: domainSchema, enabled: z.literal(false) }),
]);

export interface EmailDomainsDeps {
  db?: CloudDb;
  /** Defaults to the process-wide client for the environment's region. */
  ses?: SesClient;
  now?: Date;
}

export interface EmailInboundDeps {
  db?: CloudDb;
  /** Defaults to the process-wide inbound client for the tenancy's region. */
  inbound?: SesInboundClient;
  /**
   * The region's bucket + topic. `null` means inbound is not configured here,
   * which is a MODE; `undefined` reads the environment.
   */
  store?: InboundStore | null;
  /** The DNS seam. Tests inject; nothing in CI resolves a real name. */
  lookupMx?: MxLookup;
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
      ...(body.value.label === undefined ? {} : { label: body.value.label }),
    });
    return json(200, result);
  });
}

/**
 * `POST /api/email/domains/inbound` — turn replies on for a domain, or off.
 *
 * The receiving twin of the return-path toggle, and one endpoint rather than
 * two because the state it sets is one bit. What it answers with on the way in
 * is the whole point: the MX record the customer has to publish, because an
 * enable they cannot act on has changed nothing they can see.
 *
 * Every refusal below belongs to the service. This handler adds no policy of
 * its own — it may not soften the typed MX confirmation, and it may not decide
 * a forwarding address is optional.
 */
export async function handleDomainInbound(
  request: Request,
  deps: EmailInboundDeps = {},
): Promise<Response> {
  return withInbound(request, deps, async (inbound) => {
    const body = await readBody(
      request,
      inboundBodySchema,
      "Name the `domain` and whether inbound is `enabled`. Enabling also takes " +
        "`forwardTo`, and optionally `label` and `confirmMxReplacement`.",
    );
    if (!body.ok) return body.response;
    const wanted = body.value;

    if (!wanted.enabled) {
      // Ownership is the service's first act here too, so a stranger cannot
      // even learn whether a domain is receiving.
      return json(200, {
        enabled: false,
        status: await inbound.disable(wanted.domain),
      });
    }

    const status = await inbound.enable({
      domain: wanted.domain,
      ...(wanted.forwardTo === undefined
        ? {}
        : { forwardTo: wanted.forwardTo }),
      ...(wanted.label === undefined ? {} : { label: wanted.label }),
      ...(wanted.confirmMxReplacement === undefined
        ? {}
        : { confirmMxReplacement: wanted.confirmMxReplacement }),
    });
    return json(200, { enabled: true, status });
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
async function withRelayCaller(
  request: Request,
  deps: { db?: CloudDb; now?: Date },
  run: (caller: RelayCaller) => Promise<Response>,
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

  try {
    return await run(caller);
  } catch (error) {
    return failureResponse(error, caller);
  }
}

async function withCaller(
  request: Request,
  deps: EmailDomainsDeps,
  run: (domains: HogsendDomains, caller: RelayCaller) => Promise<Response>,
): Promise<Response> {
  return withRelayCaller(request, deps, (caller) =>
    run(
      createHogsendDomains(
        {
          environmentId: caller.environmentId,
          actor: `relay:${caller.tokenId}`,
        },
        {
          ...(deps.db ? { db: deps.db } : {}),
          ...(deps.ses ? { ses: deps.ses } : {}),
        },
      ),
      caller,
    ),
  );
}

/**
 * The same steps, in the same order, for the RECEIVING service.
 *
 * It shares `withRelayCaller` rather than repeating it, because the ordering —
 * auth, then limit, then anything the caller controls — is a security posture,
 * and a second copy of it is how one endpoint quietly loses a step. The
 * environment comes from the token here too; a body may not name its own.
 */
async function withInbound(
  request: Request,
  deps: EmailInboundDeps,
  run: (inbound: HogsendInbound, caller: RelayCaller) => Promise<Response>,
): Promise<Response> {
  return withRelayCaller(request, deps, (caller) =>
    run(
      createHogsendInbound(
        {
          environmentId: caller.environmentId,
          actor: `relay:${caller.tokenId}`,
        },
        {
          ...(deps.db ? { db: deps.db } : {}),
          ...(deps.inbound ? { inbound: deps.inbound } : {}),
          // `null` is a MODE (this region does not receive), so it may not be
          // collapsed into "not supplied" — that would read the environment
          // and silently enable a store the caller said was absent.
          ...(deps.store === undefined ? {} : { store: deps.store }),
          ...(deps.lookupMx ? { lookupMx: deps.lookupMx } : {}),
        },
      ),
      caller,
    ),
  );
}

function failureResponse(error: unknown, caller: RelayCaller): Response {
  // A rule the caller can act on: an unparseable domain, an environment with no
  // Hogsend Email tenancy, an identity that is not there. The `code` travels
  // verbatim so the plugin and Studio can branch on it.
  if (error instanceof NotFoundError) {
    return fail(404, error.code, error.message);
  }
  // 409, ahead of the generic 400: the request is well-formed and the caller is
  // authenticated — what conflicts is the world. Another environment holds this
  // domain, or nobody does and it needs an operator. The message carries the
  // remedy; it names no tenant, because a refusal that said WHO holds the
  // domain would answer the question an enumerating caller asked.
  if (error instanceof DomainNotOwnedError) {
    return fail(409, error.code, error.message);
  }
  // 409 for the same reason, and ahead of the generic 400: the request is
  // well-formed, and what conflicts is somebody else's MX already receiving at
  // the name we would publish. The override phrase travels as its OWN field so
  // a UI can render the exact string that has to be typed rather than parsing
  // it back out of prose — and it is never applied for the caller, because the
  // cost of guessing wrong is a deleted company mailbox.
  if (error instanceof ForeignInboundMxError) {
    return json(409, {
      error: error.code,
      message: error.message,
      inboundDomain: error.inboundDomain,
      displacedMx: error.exchanges,
      confirmMxReplacement: inboundMxOverridePhrase(error.inboundDomain),
    });
  }
  // Every other service refusal, verbatim: the `code` and the sentence both
  // travel, because a caller told "bad request" cannot tell a missing
  // forwarding address from a domain already receiving on another label.
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
  /** What a valid body looks like. Named per endpoint, because "name the
   * domain, and nothing else" is a lie on the toggles that take more. */
  hint = "Name the `domain`, and nothing else.",
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
          message: `The request body is not a valid domains request. ${hint}`,
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
