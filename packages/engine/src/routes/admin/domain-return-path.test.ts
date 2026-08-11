import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  DnsRecord,
  DomainStatus,
  DomainsCapability,
  EmailProvider,
  SetReturnPathInput,
} from "@hogsend/core";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { SENDING_DOMAIN_GUIDANCE } from "../../lib/sending-domain-guidance.js";
import { domainRouter } from "./domain.js";

// PRD 20 task 3 — `POST /v1/admin/domain/return-path`. Everything here runs
// against the router with a fake container: no DB, no network, no env. The
// laws being held:
//
//  - BOTH unsupported cases 501 (no `domains` at all; `domains` without
//    `setReturnPath`) — capability gaps answer like capability gaps, never
//    throw;
//  - on reports the two extra records as `pending`; off stops reporting them
//    and the domain stays fully verified (off is not a warning state);
//  - an invalid label is refused BY NAME before any provider traffic;
//  - no user-facing string drifts into claiming the return path affects where
//    a customer's incoming mail lands (it carries bounces).

const DOMAIN = "acme.test";

const DKIM: DnsRecord = {
  type: "TXT",
  name: `hogsend._domainkey.${DOMAIN}`,
  value: "p=FAKE",
  purpose: "dkim",
  status: "verified",
};

function returnPathRecords(label: string): DnsRecord[] {
  return [
    {
      type: "MX",
      name: `${label}.${DOMAIN}`,
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
      purpose: "mx",
      status: "pending",
    },
    {
      type: "TXT",
      name: `${label}.${DOMAIN}`,
      value: "v=spf1 include:amazonses.com ~all",
      purpose: "spf",
      status: "pending",
    },
  ];
}

/** Stateful fake capability: a post-switch refresh reads the new truth back. */
function createFakeDomains() {
  const calls: SetReturnPathInput[] = [];
  let enabled = false;
  let label = "send";

  const status = (): DomainStatus => ({
    domain: DOMAIN,
    state: "verified",
    records: enabled ? [DKIM, ...returnPathRecords(label)] : [DKIM],
    providerId: "fake",
    checkedAt: "2026-08-11T00:00:00.000Z",
  });

  const capability: DomainsCapability = {
    create: async () => status(),
    get: async () => status(),
    records: async () => status().records,
    setReturnPath: async (input) => {
      calls.push(input);
      enabled = input.enabled;
      label = input.label ?? "send";
      return {
        enabled,
        mailFromDomain: enabled ? `${label}.${DOMAIN}` : null,
        status: status(),
      };
    },
  };
  return { capability, calls };
}

/**
 * Mount the real router behind a fake container. The fake status service
 * mirrors the real one's contract: it answers the provider's CURRENT state,
 * so the route's refresh-after-write is observable.
 */
function makeApp(opts: {
  domains?: DomainsCapability;
  domain?: string | null;
}) {
  const emailProvider = {
    meta: { id: "fake", name: "Fake" },
    ...(opts.domains ? { domains: opts.domains } : {}),
  } as unknown as EmailProvider;

  const domainStatus = {
    getStatus: async () => ({
      domain: opts.domain === undefined ? DOMAIN : opts.domain,
      providerId: "fake",
      supported: Boolean(emailProvider.domains),
      returnPathSupported:
        typeof emailProvider.domains?.setReturnPath === "function",
      status: emailProvider.domains
        ? await emailProvider.domains.get(DOMAIN)
        : null,
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

function post(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.request("/return-path", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the two unsupported cases", () => {
  test("501 when the provider has no domains capability at all", async () => {
    const app = makeApp({});
    const res = await post(app, { enabled: true });
    assert.equal(res.status, 501);
    assert.deepEqual(await res.json(), { error: "provider_unsupported" });
  });

  test("501 when domains exists but cannot manage the return path", async () => {
    const { capability } = createFakeDomains();
    const { setReturnPath: _dropped, ...withoutToggle } = capability;
    const app = makeApp({ domains: withoutToggle as DomainsCapability });
    const res = await post(app, { enabled: true });
    assert.equal(res.status, 501);
    assert.deepEqual(await res.json(), { error: "provider_unsupported" });
  });
});

describe("switching", () => {
  test("on answers the MX + SPF pair as pending, DKIM untouched", async () => {
    const { capability } = createFakeDomains();
    const app = makeApp({ domains: capability });

    const res = await post(app, { enabled: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      returnPath: { enabled: boolean; mailFromDomain: string | null };
      status: { status: { records: DnsRecord[] } };
    };

    assert.equal(body.returnPath.enabled, true);
    assert.equal(body.returnPath.mailFromDomain, `send.${DOMAIN}`);

    const byPurpose = new Map(
      body.status.status.records.map((r) => [r.purpose, r]),
    );
    assert.equal(body.status.status.records.length, 3);
    assert.equal(byPurpose.get("mx")?.status, "pending");
    assert.equal(byPurpose.get("spf")?.status, "pending");
    // The base record never regresses because of the upgrade.
    assert.equal(byPurpose.get("dkim")?.status, "verified");
  });

  test("off stops reporting them, and off is not a warning state", async () => {
    const { capability } = createFakeDomains();
    const app = makeApp({ domains: capability });
    await post(app, { enabled: true });

    const res = await post(app, { enabled: false });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      returnPath: { enabled: boolean; mailFromDomain: string | null };
      status: { status: { state: string; records: DnsRecord[] } };
    };

    assert.equal(body.returnPath.enabled, false);
    assert.equal(body.returnPath.mailFromDomain, null);
    assert.deepEqual(
      body.status.status.records.map((r) => r.purpose),
      ["dkim"],
    );
    // Fully verified on the one TXT record, with the upgrade off.
    assert.equal(body.status.status.state, "verified");
  });
});

describe("the label", () => {
  test("an invalid label is refused BY NAME, and the provider is never called", async () => {
    const { capability, calls } = createFakeDomains();
    const app = makeApp({ domains: capability });

    const res = await post(app, { enabled: true, label: "no.dots" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    // The rejection names the offending label — a customer who typed it can
    // see WHAT was refused, not just that something was.
    assert.match(body.error, /"no\.dots"/);
    assert.equal(calls.length, 0);
  });

  test("a label is normalized (trim + lowercase) before the provider sees it", async () => {
    const { capability, calls } = createFakeDomains();
    const app = makeApp({ domains: capability });

    const res = await post(app, { enabled: true, label: " Notifications " });
    assert.equal(res.status, 200);
    assert.equal(calls[0]?.label, "notifications");
    const body = (await res.json()) as {
      returnPath: { mailFromDomain: string | null };
    };
    assert.equal(body.returnPath.mailFromDomain, `notifications.${DOMAIN}`);
  });
});

test("400 no_domain_configured when no sending domain is derivable", async () => {
  const { capability } = createFakeDomains();
  const app = makeApp({ domains: capability, domain: null });
  const res = await post(app, { enabled: true });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "no_domain_configured" });
});

describe("copy law — the return path carries bounces", () => {
  // The misunderstanding PRD 20 exists to correct is "the return path brings
  // customer answers back". No user-facing string this feature ships may
  // contain the substring that starts that sentence.
  const FORBIDDEN = /repl/i;

  test("nothing in the router's OpenAPI surface contains it", () => {
    const doc = domainRouter.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "test", version: "0" },
    });
    assert.doesNotMatch(JSON.stringify(doc.paths), FORBIDDEN);
  });

  test("nothing in the runtime answers contains it either", async () => {
    const { capability } = createFakeDomains();
    const bodies: unknown[] = [];

    for (const [app, body] of [
      [makeApp({}), { enabled: true }],
      [makeApp({ domains: capability }), { enabled: true, label: "no.dots" }],
      [makeApp({ domains: capability, domain: null }), { enabled: true }],
      [makeApp({ domains: capability }), { enabled: true }],
      [makeApp({ domains: capability }), { enabled: false }],
    ] as const) {
      const res = await post(app, body);
      bodies.push(await res.json());
    }

    assert.doesNotMatch(JSON.stringify(bodies), FORBIDDEN);
  });
});
