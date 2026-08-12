import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  DnsRecord,
  DomainStatus,
  DomainsCapability,
  EmailProvider,
} from "@hogsend/core";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { SENDING_DOMAIN_GUIDANCE } from "../../lib/sending-domain-guidance.js";
import { domainRouter } from "./domain.js";

// A provider refusal the OPERATOR can act on must reach them intact.
//
// The failure this pins: Hogsend Cloud answers `409 domain_not_owned` when a
// domain is already claimed by another account, and its message carries the
// remedy ("an operator must delete the identity in SES…"). Every catch in this
// router flattened that into a blanket 502 with "domains request to provider
// failed: …", so Studio rendered an opaque gateway error for a request that was
// well-formed, authenticated, and had a real answer waiting inside it.
//
// The engine cannot import a provider package to type-check a provider's error,
// so the refusal is recognised STRUCTURALLY. Which makes the second law here
// just as important as the first: everything that is NOT a 409 refusal must
// still be a 502, or an expired API key would start reading like the
// customer's fault.

const DOMAIN = "acme.test";

const DKIM: DnsRecord = {
  type: "TXT",
  name: `hogsend._domainkey.${DOMAIN}`,
  value: "p=FAKE",
  purpose: "dkim",
  status: "verified",
};

/** The shape `@hogsend/plugin-hogsend` throws — status + slug + sentence. */
class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = "HogsendRelayError";
  }
}

const NOT_OWNED = () =>
  new RelayError(
    409,
    "domain_not_owned",
    `"${DOMAIN}" already exists as an email identity in Hogsend Email's shared AWS account, and it is not claimed by this account. The fix is MANUAL: an operator must delete the identity in SES.`,
  );

function makeApp(throws: () => unknown) {
  const status = (): DomainStatus => ({
    domain: DOMAIN,
    state: "verified",
    records: [DKIM],
    providerId: "hogsend",
    checkedAt: "2026-08-12T00:00:00.000Z",
  });

  const domains: DomainsCapability = {
    create: async () => {
      throw throws();
    },
    get: async () => status(),
    records: async () => status().records,
    verify: async () => {
      throw throws();
    },
    setReturnPath: async () => {
      throw throws();
    },
  };

  const emailProvider = {
    meta: { id: "hogsend", name: "Hogsend Email" },
    domains,
  } as unknown as EmailProvider;

  const domainStatus = {
    getStatus: async () => ({
      domain: DOMAIN,
      providerId: "hogsend",
      supported: true,
      returnPathSupported: true,
      status: status(),
      testMode: {
        active: false,
        reason: null,
        redirectTo: null,
        fromOverride: null,
      },
      guidance: SENDING_DOMAIN_GUIDANCE,
    }),
  };

  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("container", { emailProvider, domainStatus } as never);
    await next();
  });
  app.route("/", domainRouter);
  return app;
}

/** The three POSTs that reach the provider, and how to call each. */
const ROUTES = [
  {
    name: "add",
    call: (app: ReturnType<typeof makeApp>) =>
      app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: DOMAIN }),
      }),
  },
  {
    name: "verify",
    call: (app: ReturnType<typeof makeApp>) =>
      app.request("/verify", { method: "POST" }),
  },
  {
    name: "return-path",
    call: (app: ReturnType<typeof makeApp>) =>
      app.request("/return-path", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
  },
] as const;

describe("a provider conflict reaches the operator", () => {
  for (const route of ROUTES) {
    test(`${route.name} answers 409 with the provider's slug and sentence`, async () => {
      const res = await route.call(makeApp(NOT_OWNED));

      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: string; message: string };
      // The machine-readable slug, so Studio and the CLI can branch on it.
      assert.equal(body.error, "domain_not_owned");
      // …and the REMEDY, which is the whole reason a 502 was wrong: the
      // sentence tells the operator what to do, and a gateway error does not.
      assert.match(body.message, /manual/i);
      assert.match(body.message, /delete the identity/i);
    });
  }
});

describe("everything else stays a 502", () => {
  for (const route of ROUTES) {
    test(`${route.name} keeps 502 for an opaque provider failure`, async () => {
      const res = await route.call(makeApp(() => new Error("socket hang up")));
      assert.equal(res.status, 502);
      assert.match(
        ((await res.json()) as { error: string }).error,
        /socket hang up/,
      );
    });

    test(`${route.name} keeps 502 for a provider 401 — our key, not their request`, async () => {
      // A revoked or send-only API key is OUR misconfiguration. Forwarding it
      // would tell the customer their request was at fault for an outage they
      // cannot do anything about.
      const res = await route.call(
        makeApp(() => new RelayError(401, "invalid_token", "bad token")),
      );
      assert.equal(res.status, 502);
    });

    test(`${route.name} keeps 502 for a 409 with no slug`, async () => {
      // Structural matching has to be strict in BOTH directions: a bare object
      // that happens to carry `status: 409` is not a typed refusal, and
      // answering one with an empty `error` would hand Studio a code it cannot
      // branch on and a message that says nothing.
      const res = await route.call(
        makeApp(() => Object.assign(new Error("conflict"), { status: 409 })),
      );
      assert.equal(res.status, 502);
    });
  }
});
