import type {
  DnsRecord,
  DomainStatus,
  DomainsCapability,
  ReturnPathState,
  SetReturnPathInput,
} from "@hogsend/core";
import { HogsendRelayError } from "./errors.js";

/**
 * The Hogsend Email implementation of the engine's optional `domains`
 * capability — a thin HTTP client over the Cloud control plane's domain
 * endpoints.
 *
 * **PRESENCE IS THE GATE.** Attaching this to the provider is what lights up
 * the engine's admin domain routes, the `hogsend domain` CLI and Studio's Setup
 * view. There is no new UI in this package and none is needed; the surfaces
 * already exist and were waiting for a provider that answers.
 *
 * The tenant instance has NO AWS access — the AWS credential lives in the
 * control plane and never leaves it (DECISIONS §3.5) — so every call here rides
 * the SAME bearer relay token the send wire uses. There is deliberately no
 * second credential and no second auth path.
 *
 * It is as dumb as the send wire: plain HTTP, no caching, no env derivation, no
 * test-mode policy. All of that lives in the engine's `DomainStatusService`.
 * The control plane produces `DomainStatus` values directly, so the only work
 * here is asserting the answer has the shape the contract promises rather than
 * re-deriving it — a relay that answered nonsense must fail loudly rather than
 * hand the engine a half-built status.
 */

const DOMAINS_PATH = "/api/email/domains";
const VERIFY_PATH = "/api/email/domains/verify";
const RETURN_PATH = "/api/email/domains/return-path";

export interface HogsendDomainsConfig {
  /** Origin of the Hogsend Cloud control plane. */
  relayUrl: string;
  /** The environment's relay token (`hsrel_…`). */
  tenantToken: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
}

/**
 * What the branded-return-path toggle answers, in both directions.
 *
 * Alias for the core {@link ReturnPathState}: PRD 20 promoted `setReturnPath`
 * onto the neutral `DomainsCapability` (a custom MAIL FROM is a standard ESP
 * concept, not a Hogsend invention), and the bespoke result this package
 * shipped first was already field-for-field that shape. Kept as a name so
 * existing importers keep compiling; new code should reach for
 * `ReturnPathState` from `@hogsend/core`.
 */
export type HogsendReturnPathResult = ReturnPathState;

/**
 * The core contract with the optional members this provider ALWAYS has.
 *
 * RETYPED to the core `setReturnPath` rather than delegating to a second
 * bespoke method: the shapes were already identical, so delegation would have
 * left two names for one wire and a permanent "which one do I call?" question.
 * One surface — the engine's admin route reaches the toggle through the
 * neutral contract with no Hogsend-specific cast anywhere.
 */
export interface HogsendDomainsCapability extends DomainsCapability {
  verify(domain: string): Promise<DomainStatus>;
  setReturnPath(input: SetReturnPathInput): Promise<ReturnPathState>;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * A status is only a status when it carries the two fields every surface
 * renders. Anything else means the relay answered something we do not
 * understand, and passing it on would surface as an empty records table with no
 * explanation.
 */
function asDomainStatus(value: unknown, path: string): DomainStatus {
  const record = asRecord(value);
  if (typeof record.domain !== "string" || !Array.isArray(record.records)) {
    throw new HogsendRelayError({
      status: 200,
      message: `Hogsend relay ${path} returned no usable domain status.`,
      body: value,
    });
  }
  return record as unknown as DomainStatus;
}

/** Build the Hogsend Email {@link DomainsCapability}. */
export function createHogsendRelayDomains(
  cfg: HogsendDomainsConfig,
): HogsendDomainsCapability {
  const relayUrl = cfg.relayUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetch ?? fetch;

  /**
   * One relay call, with the same posture the send wire holds: NOTHING is
   * retried here. Retry policy belongs to whatever can see the whole operation;
   * a wire that quietly retried would double the load on an already-throttled
   * control plane.
   */
  const call = async (
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; query?: string },
  ): Promise<unknown> => {
    const url = `${relayUrl}${path}${init.query ?? ""}`;
    const response = await fetchImpl(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${cfg.tenantToken}`,
        Accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const body = asRecord(parsed);
      throw new HogsendRelayError({
        status: response.status,
        ...(typeof body.error === "string" ? { error: body.error } : {}),
        message:
          typeof body.message === "string" && body.message.length > 0
            ? body.message
            : `Hogsend relay ${path} failed with status ${response.status}`,
        body: parsed,
      });
    }
    return parsed;
  };

  const get = async (domain: string): Promise<DomainStatus | null> => {
    const body = await call(DOMAINS_PATH, {
      method: "GET",
      query: `?domain=${encodeURIComponent(domain)}`,
    });
    const status = asRecord(body).status;
    // `null` is the contract's ordinary answer for "the provider does not know
    // this domain", never an error.
    return status === null || status === undefined
      ? null
      : asDomainStatus(status, DOMAINS_PATH);
  };

  return {
    async create(domain: string): Promise<DomainStatus> {
      const body = await call(DOMAINS_PATH, {
        method: "POST",
        body: { domain },
      });
      return asDomainStatus(asRecord(body).status, DOMAINS_PATH);
    },

    get,

    async records(domain: string): Promise<DnsRecord[]> {
      return (await get(domain))?.records ?? [];
    },

    async verify(domain: string): Promise<DomainStatus> {
      const body = await call(VERIFY_PATH, {
        method: "POST",
        body: { domain },
      });
      return asDomainStatus(asRecord(body).status, VERIFY_PATH);
    },

    async setReturnPath(input: SetReturnPathInput): Promise<ReturnPathState> {
      const body = asRecord(
        await call(RETURN_PATH, {
          method: "POST",
          body: {
            domain: input.domain,
            enabled: input.enabled,
            // Omitted (not null) when unchosen: the control plane strict-parses
            // the body, and its `send` default is what keeps records byte-stable
            // for customers who never picked a label.
            ...(input.label === undefined ? {} : { label: input.label }),
          },
        }),
      );
      return {
        // What SES actually holds now, as the control plane read it back —
        // never an echo of what was asked for.
        enabled: body.enabled === true,
        mailFromDomain:
          typeof body.mailFromDomain === "string" ? body.mailFromDomain : null,
        status: asDomainStatus(body.status, RETURN_PATH),
      };
    },
  };
}
