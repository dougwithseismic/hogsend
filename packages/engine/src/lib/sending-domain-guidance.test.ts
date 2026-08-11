import assert from "node:assert/strict";
import test from "node:test";

import {
  exampleSendingSubdomain,
  looksLikeRootDomain,
  SENDING_DOMAIN_GUIDANCE,
} from "./sending-domain-guidance.js";

// Same single-label rule apps/cloud/src/lib/sending-domains.ts enforces for
// return-path labels — a label we RECOMMEND must be one we can publish.
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

test("looksLikeRootDomain: true for bare two-label domains", () => {
  assert.equal(looksLikeRootDomain("acme.com"), true);
});

test("looksLikeRootDomain: normalizes case", () => {
  assert.equal(looksLikeRootDomain("ACME.COM"), true);
});

test("looksLikeRootDomain: strips a trailing dot", () => {
  assert.equal(looksLikeRootDomain("acme.com."), true);
});

test("looksLikeRootDomain: true for known multi-part public suffixes", () => {
  assert.equal(looksLikeRootDomain("acme.co.uk"), true);
  assert.equal(looksLikeRootDomain("acme.com.au"), true);
});

test("looksLikeRootDomain: false for subdomains", () => {
  assert.equal(looksLikeRootDomain("notifications.acme.com"), false);
  assert.equal(looksLikeRootDomain("mail.acme.co.uk"), false);
});

test("looksLikeRootDomain: false for empty / whitespace / single label", () => {
  assert.equal(looksLikeRootDomain(""), false);
  assert.equal(looksLikeRootDomain("   "), false);
  assert.equal(looksLikeRootDomain("localhost"), false);
});

test("exampleSendingSubdomain prefixes the first recommended label", () => {
  assert.equal(exampleSendingSubdomain("acme.com"), "notifications.acme.com");
});

test("guidance constant is frozen", () => {
  assert.equal(Object.isFrozen(SENDING_DOMAIN_GUIDANCE), true);
  assert.equal(
    Object.isFrozen(SENDING_DOMAIN_GUIDANCE.recommendedLabels),
    true,
  );
});

test("recommended labels are valid single DNS labels", () => {
  assert.ok(SENDING_DOMAIN_GUIDANCE.recommendedLabels.length > 0);
  for (const label of SENDING_DOMAIN_GUIDANCE.recommendedLabels) {
    assert.match(label, DNS_LABEL_RE);
  }
});

// --- Wire proof: the field reaches the EngineDomainStatus snapshot ----------
// No engine-package test file covers getStatus (the existing coverage lives in
// apps/api vitest), so the assertion is made here by constructing the service
// with a domains-less provider — getStatus resolves instantly without any
// provider call.

const { createDomainStatusService } = await import("./domain-status.js");

type EngineEnv = Parameters<typeof createDomainStatusService>[0]["env"];
type EngineLogger = Parameters<typeof createDomainStatusService>[0]["logger"];
type EngineProvider = Parameters<
  typeof createDomainStatusService
>[0]["provider"];

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  http: () => {},
  debug: () => {},
} as unknown as EngineLogger;

test("getStatus snapshot carries the guidance block", async () => {
  const service = createDomainStatusService({
    provider: { meta: { id: "resend", name: "Resend" } } as EngineProvider,
    env: {
      EMAIL_DOMAIN: "acme.com",
      EMAIL_FROM: undefined,
      RESEND_FROM_EMAIL: undefined,
      HOGSEND_TEST_MODE: "auto",
      HOGSEND_TEST_EMAIL: undefined,
      STUDIO_ADMIN_EMAIL: undefined,
    } as unknown as EngineEnv,
    logger: noopLogger,
  });

  const snapshot = await service.getStatus();
  assert.equal(snapshot.guidance.title, "Send from a subdomain");
});
