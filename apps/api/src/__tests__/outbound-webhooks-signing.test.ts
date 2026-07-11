import { createHmac, timingSafeEqual } from "node:crypto";
import {
  generateWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_EVENT_TYPES,
} from "@hogsend/engine";
import { describe, expect, it } from "vitest";

// Pure-unit test: the signing core (Section 1.2) is `node:crypto` + `svix` only —
// no DB, no Hatchet, no app. It asserts the sign→verify round-trip, BOTH header
// casings (Title-Case + lowercase + the `svix-*` aliases), and a hand-rolled
// `node:crypto` cross-check that the documented fallback (the one the SDK ships)
// produces the SAME `v1,<base64>` signature svix does over the SAME bytes.

/**
 * The documented `node:crypto` fallback from `webhook-signing.ts` (and the
 * `@hogsend/client` verify helper): drop the `whsec_` prefix, base64-decode the
 * remainder as the HMAC key, sign `${id}.${ts}.${body}`, render `v1,<base64>`.
 */
function nodeCryptoSign(opts: {
  id: string;
  timestamp: number;
  body: string;
  secret: string;
}): string {
  const key = Buffer.from(opts.secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key)
    .update(`${opts.id}.${opts.timestamp}.${opts.body}`)
    .digest("base64");
  return `v1,${sig}`;
}

/** Pull the first `v1,<sig>` candidate out of a space-delimited header value. */
function firstV1(headerValue: string): string {
  const candidate = headerValue
    .split(" ")
    .find((part) => part.startsWith("v1,"));
  if (!candidate) throw new Error(`no v1 signature in: ${headerValue}`);
  return candidate;
}

describe("generateWebhookSecret", () => {
  it("mints a whsec_-prefixed secret whose prefix is the first 12 chars", () => {
    const { secret, secretPrefix } = generateWebhookSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(secretPrefix).toBe(secret.slice(0, 12));
    expect(secretPrefix.startsWith("whsec_")).toBe(true);
  });

  it("decodes to a 32-byte key (the body is standard base64, svix-decodable)", () => {
    const { secret } = generateWebhookSecret();
    const body = secret.slice("whsec_".length);
    // Standard base64 (NOT base64url) so svix's strict decoder accepts it. Only
    // the body matters — the `whsec_` prefix legitimately contains an underscore.
    expect(body).not.toMatch(/[-_]/);
    const key = Buffer.from(body, "base64");
    expect(key.length).toBe(32);
    // `new Webhook(secret)` must not throw on the generated value (it does on
    // base64url secrets) — signing a trivial payload proves it round-trips.
    expect(() =>
      signWebhook({ id: "msg_x", timestamp: 1, payload: {}, secret }),
    ).not.toThrow();
  });

  it("mints a unique secret each call", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("signWebhook", () => {
  const secret = generateWebhookSecret().secret;
  const id = "msg_round-trip-1";
  const timestamp = Math.floor(Date.now() / 1000);

  it("emits the full Standard Webhooks header set + the exact signed body", () => {
    const payload = { id, type: "contact.created", data: { email: "a@b.com" } };
    const { headers, body } = signWebhook({ id, timestamp, payload, secret });

    expect(headers["Webhook-Id"]).toBe(id);
    expect(headers["Webhook-Timestamp"]).toBe(String(timestamp));
    expect(headers["Webhook-Signature"]).toMatch(/^v1,/);
    expect(headers["Content-Type"]).toBe("application/json");
    // The returned body is EXACTLY JSON.stringify(payload) — the bytes signed.
    expect(body).toBe(JSON.stringify(payload));
  });

  it("uses a string payload verbatim (never re-stringified)", () => {
    const raw = '{"already":"stringified"}';
    const { body } = signWebhook({ id, timestamp, payload: raw, secret });
    expect(body).toBe(raw);
  });

  it("matches the node:crypto fallback signature byte-for-byte", () => {
    const payload = { hello: "world", n: 42 };
    const { headers, body } = signWebhook({ id, timestamp, payload, secret });

    const svixSig = firstV1(headers["Webhook-Signature"]);
    const fallbackSig = nodeCryptoSign({ id, timestamp, body, secret });

    // Constant-time compare — the two independent implementations agree.
    const a = Buffer.from(svixSig, "utf8");
    const b = Buffer.from(fallbackSig, "utf8");
    expect(a.length).toBe(b.length);
    expect(timingSafeEqual(a, b)).toBe(true);
  });
});

describe("verifyWebhookSignature round-trip", () => {
  const secret = generateWebhookSecret().secret;
  const id = "msg_verify-1";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = { id, type: "email.sent", data: { to: "x@y.com" } };
  const { headers, body } = signWebhook({ id, timestamp, payload, secret });

  it("verifies with Title-Case headers (the exact set signWebhook emits)", () => {
    const result = verifyWebhookSignature({
      payload: body,
      headers: {
        "Webhook-Id": headers["Webhook-Id"],
        "Webhook-Timestamp": headers["Webhook-Timestamp"],
        "Webhook-Signature": headers["Webhook-Signature"],
      },
      secret,
    });
    // svix returns the parsed JSON on success.
    expect(result).toEqual(payload);
  });

  it("verifies with lowercase header keys", () => {
    const result = verifyWebhookSignature({
      payload: body,
      headers: {
        "webhook-id": headers["Webhook-Id"],
        "webhook-timestamp": headers["Webhook-Timestamp"],
        "webhook-signature": headers["Webhook-Signature"],
      },
      secret,
    });
    expect(result).toEqual(payload);
  });

  it("verifies with the svix-* aliased header keys", () => {
    const result = verifyWebhookSignature({
      payload: body,
      headers: {
        "svix-id": headers["Webhook-Id"],
        "svix-timestamp": headers["Webhook-Timestamp"],
        "svix-signature": headers["Webhook-Signature"],
      },
      secret,
    });
    expect(result).toEqual(payload);
  });

  it("throws on a tampered body (signature no longer covers the bytes)", () => {
    expect(() =>
      verifyWebhookSignature({
        payload: `${body} `,
        headers: {
          "webhook-id": headers["Webhook-Id"],
          "webhook-timestamp": headers["Webhook-Timestamp"],
          "webhook-signature": headers["Webhook-Signature"],
        },
        secret,
      }),
    ).toThrow();
  });

  it("throws when verified with the wrong secret", () => {
    const otherSecret = generateWebhookSecret().secret;
    expect(() =>
      verifyWebhookSignature({
        payload: body,
        headers: {
          "webhook-id": headers["Webhook-Id"],
          "webhook-timestamp": headers["Webhook-Timestamp"],
          "webhook-signature": headers["Webhook-Signature"],
        },
        secret: otherSecret,
      }),
    ).toThrow();
  });

  it("accepts the node:crypto fallback signature (cross-impl verify)", () => {
    // A subscriber that signed with the documented node:crypto fallback (no svix
    // dependency) must still verify under svix — the schemes are identical.
    const fallbackSig = nodeCryptoSign({ id, timestamp, body, secret });
    const result = verifyWebhookSignature({
      payload: body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": fallbackSig,
      },
      secret,
    });
    expect(result).toEqual(payload);
  });
});

describe("WEBHOOK_EVENT_TYPES catalog (single source of truth)", () => {
  it("is exactly the 21-event catalog, in order", () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual([
      "contact.created",
      "contact.updated",
      "contact.deleted",
      "contact.unsubscribed",
      // The opt-IN mirror of contact.unsubscribed (consent audit for the
      // explicit-opt-in sms channel; carries `source` provenance).
      "contact.subscribed",
      "email.sent",
      "email.delivered",
      "email.opened",
      "email.clicked",
      "email.action",
      "email.bounced",
      "email.complained",
      // SMS lifecycle (sibling of the email.* funnel; sms.clicked is the
      // first-party /s/:code short-link click).
      "sms.sent",
      "sms.delivered",
      "sms.failed",
      "sms.clicked",
      "journey.completed",
      "bucket.entered",
      "bucket.left",
      // NON-email tracked-link click (MF-missing #3): the deliberate counterpart
      // to `email.clicked` so a Discord/referral/ad-hoc click never masquerades
      // as an email click.
      "link.clicked",
      // Landing-confirmed arrival (opt-in hs_ref + POST /v1/t/arrive): the
      // subset of link.clicked that carries the VISITOR's identity.
      "link.arrived",
    ]);
  });

  it("does NOT include the out-of-band webhook.test sentinel", () => {
    expect(WEBHOOK_EVENT_TYPES as readonly string[]).not.toContain(
      "webhook.test",
    );
  });
});
