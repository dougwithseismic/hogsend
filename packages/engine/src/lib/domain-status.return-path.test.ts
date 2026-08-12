import assert from "node:assert/strict";
import { test } from "node:test";
import type { DomainsCapability, EmailProvider } from "@hogsend/core";
import { createDomainStatusService } from "./domain-status.js";

// `EngineDomainStatus.returnPathSupported` is the discovery bit Studio/CLI key
// the return-path control off (PRD 20 EARS: when the capability has no
// `setReturnPath`, the upgrade is reported unavailable — never rendered as a
// dead control). Held here against the REAL service, since the admin-route
// tests run on a fake status service.

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as never;

const STATUS = {
  domain: "acme.test",
  state: "verified",
  records: [],
  providerId: "fake",
  checkedAt: "2026-08-11T00:00:00.000Z",
} as const;

function makeService(domains?: DomainsCapability) {
  const provider = {
    meta: { id: "fake", name: "Fake" },
    ...(domains ? { domains } : {}),
  } as unknown as EmailProvider;
  return createDomainStatusService({
    provider,
    env: { EMAIL_DOMAIN: "acme.test", HOGSEND_TEST_MODE: "false" } as never,
    logger: noopLogger,
  });
}

const baseCapability: DomainsCapability = {
  create: async () => ({ ...STATUS, records: [] }),
  get: async () => ({ ...STATUS, records: [] }),
  records: async () => [],
};

test("returnPathSupported is true when the capability has setReturnPath", async () => {
  const service = makeService({
    ...baseCapability,
    setReturnPath: async () => ({
      enabled: true,
      mailFromDomain: "send.acme.test",
      status: { ...STATUS, records: [] },
    }),
  });
  const status = await service.getStatus();
  assert.equal(status.returnPathSupported, true);
});

test("returnPathSupported is false when domains exists without it", async () => {
  const status = await makeService(baseCapability).getStatus();
  assert.equal(status.supported, true);
  assert.equal(status.returnPathSupported, false);
});

test("returnPathSupported is false when there is no domains capability", async () => {
  const status = await makeService().getStatus();
  assert.equal(status.supported, false);
  assert.equal(status.returnPathSupported, false);
});
