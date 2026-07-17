import { createHmac } from "node:crypto";
import {
  clerkSource,
  generateWebhookSecret,
  intercomSource,
  PRESET_SOURCES,
  presetsFromEnv,
  segmentSource,
  signWebhook,
  stripeSource,
  supabaseSource,
  verifySignature,
} from "@hogsend/engine";
import { describe, expect, it } from "vitest";

// Pure-unit test (mirrors webhook-sources.test.ts): the 4 integration presets are
// `defineWebhookSource` + a `transform()`. We assert (a) each transform maps the
// provider payload to the normalized Hogsend vocabulary with the STRICT D2 split
// (identity → contactProperties ONLY, behavioral → eventProperties ONLY), (b) the
// idempotencyKey is the provider event id where the plan requires it, and (c) the
// signature verifier accepts a correctly-signed body and FAILS CLOSED on a missing
// header / bad signature (the security-sensitive divergence from "match").

// The ctx passed to a preset transform — none of the 4 read `db`/`logger`, they
// derive everything from the (already schema-validated) payload (mirrors the
// posthog source unit test).
const ctx = { db: {} as never, logger: {} as never };

// ---------------------------------------------------------------------------
// Clerk (svix-signed)
// ---------------------------------------------------------------------------

describe("Clerk preset transform", () => {
  it("maps user.created → contact.created with the D2 split", async () => {
    const result = await clerkSource.transform(
      {
        type: "user.created",
        data: {
          id: "user_clerk_1",
          primary_email_address_id: "idn_1",
          email_addresses: [
            { id: "idn_1", email_address: "ada@example.com" },
            { id: "idn_2", email_address: "secondary@example.com" },
          ],
          first_name: "Ada",
          last_name: "Lovelace",
          image_url: "https://img/ada.png",
          public_metadata: { plan: "pro" },
        },
      },
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result?.event).toBe("contact.created");
    expect(result?.userId).toBe("user_clerk_1");
    // Primary email resolved off primary_email_address_id (not addresses[0]).
    expect(result?.userEmail).toBe("ada@example.com");

    // Identity/profile → contactProperties ONLY (camelCase + provider-prefixed id).
    expect(result?.contactProperties).toEqual({
      plan: "pro",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: "https://img/ada.png",
      clerkUserId: "user_clerk_1",
    });

    // Behavioral/source → eventProperties ONLY. The two bags are NEVER merged.
    expect(result?.eventProperties).toEqual({
      source: "clerk",
      clerkUserId: "user_clerk_1",
      _clerkEvent: "user.created",
    });
    expect(result?.eventProperties.firstName).toBeUndefined();
    expect(result?.contactProperties?.source).toBeUndefined();
  });

  it("maps user.updated → contact.updated", async () => {
    const result = await clerkSource.transform(
      { type: "user.updated", data: { id: "user_2", email_addresses: [] } },
      ctx,
    );
    expect(result?.event).toBe("contact.updated");
    expect(result?.userId).toBe("user_2");
  });

  it("maps user.deleted → contact.deleted (EVENT only, empty contactProperties)", async () => {
    const result = await clerkSource.transform(
      { type: "user.deleted", data: { id: "user_3" } },
      ctx,
    );
    expect(result?.event).toBe("contact.deleted");
    expect(result?.userId).toBe("user_3");
    // Decision #15: deletes emit the event only — no profile to merge.
    expect(result?.contactProperties).toEqual({});
  });

  it("maps waitlistEntry.created → waitlist.joined", async () => {
    const result = await clerkSource.transform(
      {
        type: "waitlistEntry.created",
        data: { id: "wl_1", email_address: "waiter@example.com" },
      },
      ctx,
    );
    expect(result?.event).toBe("waitlist.joined");
    expect(result?.userEmail).toBe("waiter@example.com");
    expect(result?.eventProperties).toEqual({
      source: "clerk",
      _clerkEvent: "waitlistEntry.created",
    });
  });

  it("skips an unrecognized clerk event", async () => {
    const result = await clerkSource.transform(
      { type: "session.created", data: { id: "sess_1" } },
      ctx,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Supabase (svix-signed, with x-supabase-webhook-secret fallback)
// ---------------------------------------------------------------------------

describe("Supabase preset transform", () => {
  it("maps an auth.users INSERT → contact.created with the D2 split", async () => {
    const result = await supabaseSource.transform(
      {
        type: "INSERT",
        schema: "auth",
        table: "users",
        record: {
          id: "uuid-abc",
          email: "sb@example.com",
          phone: "+15551234",
          email_confirmed_at: "2026-01-01T00:00:00Z",
          raw_user_meta_data: { plan: "team" },
        },
      },
      ctx,
    );

    expect(result?.event).toBe("contact.created");
    expect(result?.userId).toBe("uuid-abc");
    expect(result?.userEmail).toBe("sb@example.com");

    expect(result?.contactProperties).toEqual({
      plan: "team",
      phone: "+15551234",
      emailVerified: true,
      supabaseUserId: "uuid-abc",
    });
    expect(result?.eventProperties).toEqual({
      source: "supabase",
      supabaseUserId: "uuid-abc",
      _supabaseEvent: "INSERT",
    });
  });

  it("maps UPDATE → contact.updated and DELETE → contact.deleted (from old_record)", async () => {
    const updated = await supabaseSource.transform(
      {
        type: "UPDATE",
        schema: "auth",
        table: "users",
        record: { id: "u1", email: "u@e.com" },
      },
      ctx,
    );
    expect(updated?.event).toBe("contact.updated");

    const deleted = await supabaseSource.transform(
      {
        type: "DELETE",
        schema: "auth",
        table: "users",
        old_record: { id: "u2", email: "gone@e.com" },
      },
      ctx,
    );
    expect(deleted?.event).toBe("contact.deleted");
    expect(deleted?.userId).toBe("u2");
    expect(deleted?.contactProperties).toEqual({});
  });

  it("skips rows outside auth.users", async () => {
    const result = await supabaseSource.transform(
      {
        type: "INSERT",
        schema: "public",
        table: "orders",
        record: { id: "o1" },
      },
      ctx,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stripe (signature-verified, idempotencyKey = event id)
// ---------------------------------------------------------------------------

describe("Stripe preset transform", () => {
  it("maps customer.created → contact.created, idempotencyKey = event id", async () => {
    const result = await stripeSource.transform(
      {
        id: "evt_stripe_1",
        type: "customer.created",
        data: {
          object: {
            id: "cus_123",
            object: "customer",
            email: "stripe@example.com",
            name: "Stripe User",
            phone: "+1999",
            metadata: { tier: "gold" },
          },
        },
      },
      ctx,
    );

    expect(result?.event).toBe("contact.created");
    expect(result?.userId).toBe("cus_123");
    expect(result?.userEmail).toBe("stripe@example.com");
    // Dedupe on the Stripe event id (at-least-once redelivery guard).
    expect(result?.idempotencyKey).toBe("evt_stripe_1");

    expect(result?.contactProperties).toEqual({
      tier: "gold",
      name: "Stripe User",
      phone: "+1999",
      stripeCustomerId: "cus_123",
    });
    expect(result?.eventProperties).toMatchObject({
      source: "stripe",
      stripeCustomerId: "cus_123",
      stripeEventId: "evt_stripe_1",
      _stripeEvent: "customer.created",
    });
    // The profile name/phone never leak into eventProperties.
    expect(result?.eventProperties.name).toBeUndefined();
  });

  it("maps customer.subscription.updated → subscription.updated keyed on obj.customer", async () => {
    const result = await stripeSource.transform(
      {
        id: "evt_sub_1",
        type: "customer.subscription.updated",
        data: {
          object: { id: "sub_1", object: "subscription", customer: "cus_999" },
        },
      },
      ctx,
    );
    expect(result?.event).toBe("subscription.updated");
    // userId = obj.customer for sub/invoice events.
    expect(result?.userId).toBe("cus_999");
    expect(result?.idempotencyKey).toBe("evt_sub_1");
    // Sub events are event-only (no profile merge).
    expect(result?.contactProperties).toEqual({});
  });

  it("maps invoice.paid → invoice.paid keyed on obj.customer", async () => {
    const result = await stripeSource.transform(
      {
        id: "evt_inv_1",
        type: "invoice.paid",
        data: {
          object: { id: "in_1", object: "invoice", customer: "cus_555" },
        },
      },
      ctx,
    );
    expect(result?.event).toBe("invoice.paid");
    expect(result?.userId).toBe("cus_555");
  });

  it("maps customer.deleted → contact.deleted (event only)", async () => {
    const result = await stripeSource.transform(
      {
        id: "evt_del_1",
        type: "customer.deleted",
        data: { object: { id: "cus_del", object: "customer" } },
      },
      ctx,
    );
    expect(result?.event).toBe("contact.deleted");
    expect(result?.contactProperties).toEqual({});
  });

  it("skips an unmapped stripe event", async () => {
    const result = await stripeSource.transform(
      {
        id: "evt_x",
        type: "charge.succeeded",
        data: { object: { id: "ch_1", object: "charge" } },
      },
      ctx,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Segment (hmac-hex signed, idempotencyKey = messageId)
// ---------------------------------------------------------------------------

describe("Segment preset transform", () => {
  it("maps identify → contact.updated (traits → contactProperties ONLY)", async () => {
    const result = await segmentSource.transform(
      {
        type: "identify",
        messageId: "msg_seg_1",
        userId: "seg_user_1",
        traits: { email: "seg@example.com", plan: "scale" },
      },
      ctx,
    );

    expect(result?.event).toBe("contact.updated");
    expect(result?.userId).toBe("seg_user_1");
    expect(result?.userEmail).toBe("seg@example.com");
    expect(result?.idempotencyKey).toBe("msg_seg_1");

    expect(result?.contactProperties).toMatchObject({
      email: "seg@example.com",
      plan: "scale",
      source: "segment",
    });
    // identify carries NO behavioral payload bag.
    expect(result?.eventProperties).toEqual({
      source: "segment",
      _segmentType: "identify",
    });
  });

  it("maps track → the literal event name (properties → eventProperties ONLY)", async () => {
    const result = await segmentSource.transform(
      {
        type: "track",
        event: "Order Completed",
        messageId: "msg_seg_2",
        userId: "seg_user_2",
        properties: { total: 99, currency: "USD" },
      },
      ctx,
    );

    expect(result?.event).toBe("Order Completed");
    expect(result?.userId).toBe("seg_user_2");
    expect(result?.idempotencyKey).toBe("msg_seg_2");
    expect(result?.eventProperties).toMatchObject({
      total: 99,
      currency: "USD",
      source: "segment",
    });
    expect(result?.contactProperties).toEqual({});
  });

  it("skips page/screen/group/alias", async () => {
    for (const type of ["page", "screen", "group", "alias"]) {
      const result = await segmentSource.transform(
        { type, userId: "u", messageId: "m" },
        ctx,
      );
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Intercom / Fin (X-Hub SHA1 signed, support.* lifecycle events)
// ---------------------------------------------------------------------------

describe("Intercom preset transform", () => {
  // A conversation started by a user who carries their own app user id
  // (external_id) — the load-bearing identity case.
  const startedPayload = {
    type: "notification_event",
    id: "notif_started_1",
    topic: "conversation.user.created",
    data: {
      item: {
        type: "conversation",
        id: "conv_1",
        source: {
          author: {
            type: "user",
            id: "intercom_contact_1",
            external_id: "app_user_1",
            email: "ada@example.com",
            name: "Ada Lovelace",
          },
        },
      },
    },
  };

  it("maps conversation.user.created → support.conversation_started with the D2 split", async () => {
    const result = await intercomSource.transform(startedPayload, ctx);

    expect(result?.event).toBe("support.conversation_started");
    // userId is the customer's OWN app user id (Intercom external_id), never
    // Intercom's internal contact id.
    expect(result?.userId).toBe("app_user_1");
    expect(result?.userEmail).toBe("ada@example.com");
    // Dedupe on the notification envelope id.
    expect(result?.idempotencyKey).toBe("intercom:notif_started_1");

    // Conversation metadata → eventProperties ONLY.
    expect(result?.eventProperties).toEqual({
      source: "intercom",
      _intercomTopic: "conversation.user.created",
      conversationId: "conv_1",
    });
    // Profile → contactProperties ONLY. The Intercom internal id is a reference,
    // never the identity key.
    expect(result?.contactProperties).toEqual({
      name: "Ada Lovelace",
      intercomContactId: "intercom_contact_1",
    });
    // The internal contact id NEVER becomes userId.
    expect(result?.userId).not.toBe("intercom_contact_1");
  });

  it("maps conversation.admin.closed → support.resolved carrying the Fin flag", async () => {
    const result = await intercomSource.transform(
      {
        type: "notification_event",
        id: "notif_closed_1",
        topic: "conversation.admin.closed",
        data: {
          item: {
            type: "conversation",
            id: "conv_2",
            ai_agent_participated: true,
            contacts: {
              contacts: [
                {
                  type: "contact",
                  id: "intercom_contact_2",
                  external_id: "app_user_2",
                  email: "grace@example.com",
                },
              ],
            },
          },
        },
      },
      ctx,
    );

    expect(result?.event).toBe("support.resolved");
    expect(result?.userId).toBe("app_user_2");
    expect(result?.userEmail).toBe("grace@example.com");
    expect(result?.eventProperties).toMatchObject({
      source: "intercom",
      _intercomTopic: "conversation.admin.closed",
      conversationId: "conv_2",
      isAiResolved: true,
    });
  });

  it("maps conversation.admin.assigned → support.escalated with assignee/team", async () => {
    const result = await intercomSource.transform(
      {
        type: "notification_event",
        id: "notif_assigned_1",
        topic: "conversation.admin.assigned",
        data: {
          item: {
            type: "conversation",
            id: "conv_3",
            admin_assignee_id: 4567,
            team_assignee_id: 99,
            contacts: {
              contacts: [
                {
                  type: "contact",
                  external_id: "app_user_3",
                  email: "x@e.com",
                },
              ],
            },
          },
        },
      },
      ctx,
    );

    expect(result?.event).toBe("support.escalated");
    expect(result?.userId).toBe("app_user_3");
    expect(result?.eventProperties).toMatchObject({
      assigneeId: 4567,
      teamId: 99,
    });
  });

  it("maps conversation.rating.added → support.rated carrying the numeric rating", async () => {
    const result = await intercomSource.transform(
      {
        type: "notification_event",
        id: "notif_rated_1",
        topic: "conversation.rating.added",
        data: {
          item: {
            type: "conversation",
            id: "conv_4",
            conversation_rating: { rating: 2, remark: "not great" },
            contacts: {
              contacts: [
                {
                  type: "contact",
                  external_id: "app_user_4",
                  email: "r@e.com",
                },
              ],
            },
          },
        },
      },
      ctx,
    );

    expect(result?.event).toBe("support.rated");
    expect(result?.userId).toBe("app_user_4");
    expect(result?.eventProperties.rating).toBe(2);
  });

  it("uses email as the sole identity key when Intercom has no external_id", async () => {
    const result = await intercomSource.transform(
      {
        type: "notification_event",
        id: "notif_emailonly_1",
        topic: "conversation.user.created",
        data: {
          item: {
            type: "conversation",
            id: "conv_5",
            source: {
              author: {
                type: "contact",
                id: "intercom_contact_5",
                email: "lead@example.com",
              },
            },
          },
        },
      },
      ctx,
    );

    expect(result?.event).toBe("support.conversation_started");
    // No external_id → userId is unset; the email carries identity alone.
    expect(result?.userId).toBeUndefined();
    expect(result?.userEmail).toBe("lead@example.com");
    // The Intercom internal id is still recorded for reference only.
    expect(result?.contactProperties).toEqual({
      intercomContactId: "intercom_contact_5",
    });
  });

  it("skips an admin/bot-authored conversation with no participating contact", async () => {
    const result = await intercomSource.transform(
      {
        type: "notification_event",
        id: "notif_noident_1",
        topic: "conversation.admin.closed",
        data: {
          item: {
            type: "conversation",
            id: "conv_6",
            source: {
              author: {
                type: "admin",
                id: "admin_1",
                email: "team@vendor.com",
              },
            },
          },
        },
      },
      ctx,
    );
    // No external_id AND no contact email → can't place the event on a person.
    expect(result).toBeNull();
  });

  it("skips an unrecognized topic", async () => {
    const result = await intercomSource.transform(
      {
        type: "notification_event",
        id: "notif_x",
        topic: "conversation.admin.snoozed",
        data: {
          item: {
            type: "conversation",
            id: "conv_7",
            contacts: {
              contacts: [{ type: "contact", external_id: "app_user_7" }],
            },
          },
        },
      },
      ctx,
    );
    expect(result).toBeNull();
  });
});

describe("Intercom preset signature verify (X-Hub SHA1)", () => {
  const secret = "intercom_client_secret_test";
  const rawBody = JSON.stringify({
    type: "notification_event",
    id: "notif_1",
    topic: "conversation.rating.added",
  });

  function xHubHeader(body: string, withSecret = secret): string {
    return `sha1=${createHmac("sha1", withSecret).update(body).digest("hex")}`;
  }

  // The preset uses a custom `verify` callback (SHA1 is not a built-in scheme).
  const verify =
    intercomSource.auth.type === "signature"
      ? intercomSource.auth.verify
      : undefined;

  it("uses a custom verify callback (not a built-in scheme)", () => {
    expect(intercomSource.auth.type).toBe("signature");
    expect(typeof verify).toBe("function");
  });

  it("accepts a correctly X-Hub SHA1-signed body", async () => {
    expect(
      await verify?.({
        rawBody,
        headers: { "x-hub-signature": xHubHeader(rawBody) },
        secret,
      }),
    ).toBe(true);
  });

  it("FAILS CLOSED when the x-hub-signature header is absent", async () => {
    expect(await verify?.({ rawBody, headers: {}, secret })).toBe(false);
  });

  it("rejects a tampered body", async () => {
    expect(
      await verify?.({
        rawBody: `${rawBody}x`,
        headers: { "x-hub-signature": xHubHeader(rawBody) },
        secret,
      }),
    ).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    expect(
      await verify?.({
        rawBody,
        headers: { "x-hub-signature": xHubHeader(rawBody, "wrong_secret") },
        secret,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signature verification — accept valid, FAIL CLOSED on missing/bad signature
// ---------------------------------------------------------------------------

describe("verifySignature — svix scheme (Clerk/Supabase)", () => {
  const secret = generateWebhookSecret().secret;
  const rawBody = JSON.stringify({ type: "user.created", data: { id: "u" } });

  function svixHeaders(): Record<string, string> {
    const id = "msg_svix_1";
    const timestamp = Math.floor(Date.now() / 1000);
    const { headers } = signWebhook({
      id,
      timestamp,
      payload: rawBody,
      secret,
    });
    return {
      "svix-id": headers["Webhook-Id"],
      "svix-timestamp": headers["Webhook-Timestamp"],
      "svix-signature": headers["Webhook-Signature"],
    };
  }

  it("accepts a correctly svix-signed body", () => {
    expect(
      verifySignature("svix", { rawBody, headers: svixHeaders(), secret }),
    ).toBe(true);
  });

  it("FAILS CLOSED when the svix headers are absent", () => {
    expect(verifySignature("svix", { rawBody, headers: {}, secret })).toBe(
      false,
    );
  });

  it("rejects a tampered body", () => {
    expect(
      verifySignature("svix", {
        rawBody: `${rawBody} `,
        headers: svixHeaders(),
        secret,
      }),
    ).toBe(false);
  });
});

describe("verifySignature — stripe scheme", () => {
  const secret = "whsec_stripe_test_secret";
  const rawBody = JSON.stringify({ id: "evt_1", type: "customer.created" });

  function stripeHeader(
    timestampSeconds: number,
    body: string,
    withSecret = secret,
  ): Record<string, string> {
    const sig = createHmac("sha256", withSecret)
      .update(`${timestampSeconds}.${body}`)
      .digest("hex");
    return { "stripe-signature": `t=${timestampSeconds},v1=${sig}` };
  }

  it("accepts a correctly stripe-signed body within tolerance", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifySignature("stripe", {
        rawBody,
        headers: stripeHeader(now, rawBody),
        secret,
      }),
    ).toBe(true);
  });

  it("FAILS CLOSED when the stripe-signature header is absent", () => {
    expect(verifySignature("stripe", { rawBody, headers: {}, secret })).toBe(
      false,
    );
  });

  it("rejects a signature computed with the wrong secret", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifySignature("stripe", {
        rawBody,
        headers: stripeHeader(now, rawBody, "whsec_wrong"),
        secret,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (outside the 5-min tolerance)", () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(
      verifySignature("stripe", {
        rawBody,
        headers: stripeHeader(stale, rawBody),
        secret,
      }),
    ).toBe(false);
  });

  it("rejects a body mutated after signing (exact-bytes fidelity)", () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = stripeHeader(now, rawBody);
    expect(
      verifySignature("stripe", { rawBody: `${rawBody}x`, headers, secret }),
    ).toBe(false);
  });
});

describe("verifySignature — hmac-hex scheme (Segment)", () => {
  const secret = "segment_shared_secret";
  const rawBody = JSON.stringify({ type: "track", event: "Signed Up" });

  function hmacHeader(body: string, withSecret = secret): string {
    return createHmac("sha256", withSecret).update(body).digest("hex");
  }

  it("accepts a correct hmac-hex signature under x-signature", () => {
    expect(
      verifySignature(
        "hmac-hex",
        { rawBody, headers: { "x-signature": hmacHeader(rawBody) }, secret },
        "x-signature",
      ),
    ).toBe(true);
  });

  it("FAILS CLOSED when the x-signature header is absent", () => {
    expect(
      verifySignature(
        "hmac-hex",
        { rawBody, headers: {}, secret },
        "x-signature",
      ),
    ).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(
      verifySignature(
        "hmac-hex",
        {
          rawBody,
          headers: { "x-signature": hmacHeader(rawBody, "wrong") },
          secret,
        },
        "x-signature",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// presetsFromEnv — env-gated enablement
// ---------------------------------------------------------------------------

describe("presetsFromEnv enablement", () => {
  it("AUTO-enables exactly the presets whose secret is set (absent override)", () => {
    const sources = presetsFromEnv({
      STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      CLERK_WEBHOOK_SECRET: undefined,
      SUPABASE_WEBHOOK_SECRET: undefined,
      SEGMENT_WEBHOOK_SECRET: undefined,
      ENABLED_WEBHOOK_PRESETS: undefined,
    } as never);
    expect(sources.map((s) => s.meta.id)).toEqual(["stripe"]);
  });

  it('returns nothing when ENABLED_WEBHOOK_PRESETS="none" even with secrets set', () => {
    const sources = presetsFromEnv({
      STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      CLERK_WEBHOOK_SECRET: "whsec_clerk",
      SUPABASE_WEBHOOK_SECRET: undefined,
      SEGMENT_WEBHOOK_SECRET: undefined,
      ENABLED_WEBHOOK_PRESETS: "none",
    } as never);
    expect(sources).toEqual([]);
  });

  it("honors a csv allow-list, intersected with configured secrets", () => {
    const sources = presetsFromEnv({
      STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      CLERK_WEBHOOK_SECRET: "whsec_clerk",
      SUPABASE_WEBHOOK_SECRET: undefined,
      SEGMENT_WEBHOOK_SECRET: undefined,
      // clerk is in the list AND has a secret; supabase is listed but no secret.
      ENABLED_WEBHOOK_PRESETS: "clerk,supabase",
    } as never);
    expect(sources.map((s) => s.meta.id)).toEqual(["clerk"]);
  });

  it("never enables a preset whose secret is unset (avoids a fail-closed mount)", () => {
    const sources = presetsFromEnv({
      STRIPE_WEBHOOK_SECRET: undefined,
      CLERK_WEBHOOK_SECRET: undefined,
      SUPABASE_WEBHOOK_SECRET: undefined,
      SEGMENT_WEBHOOK_SECRET: undefined,
      ENABLED_WEBHOOK_PRESETS: "*",
    } as never);
    expect(sources).toEqual([]);
  });
});

describe("PRESET_SOURCES registry", () => {
  it("indexes all 5 presets by their route id with the right auth scheme", () => {
    expect(Object.keys(PRESET_SOURCES).sort()).toEqual([
      "clerk",
      "intercom",
      "segment",
      "stripe",
      "supabase",
    ]);
    expect(PRESET_SOURCES.clerk.auth.type).toBe("signature");
    expect(PRESET_SOURCES.stripe.auth.type).toBe("signature");
    if (PRESET_SOURCES.stripe.auth.type === "signature") {
      expect(PRESET_SOURCES.stripe.auth.scheme).toBe("stripe");
    }
    if (PRESET_SOURCES.segment.auth.type === "signature") {
      expect(PRESET_SOURCES.segment.auth.scheme).toBe("hmac-hex");
    }
    if (PRESET_SOURCES.supabase.auth.type === "signature") {
      expect(PRESET_SOURCES.supabase.auth.fallbackMatchHeader).toBe(
        "x-supabase-webhook-secret",
      );
    }
  });
});
