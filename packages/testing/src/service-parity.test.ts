import type { TemplateRegistry } from "@hogsend/email";
import {
  defineJourney,
  hours,
  sendConnectorAction,
  sendEmail,
  sendFeedItem,
  sendSms,
} from "@hogsend/engine/journeys";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJourneyTest } from "./index.js";
import "./vitest.js";

const user = {
  id: "u1",
  email: "dev@acme.com",
  properties: { plan: "trial" },
};

const meta = (id: string) => ({
  id,
  name: id,
  enabled: true,
  trigger: { event: `${id}.started` },
  entryLimit: "unlimited" as const,
  suppress: hours(0),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("captured service production parity", () => {
  it.each([
    "missing",
    "toString",
  ])("rejects an unregistered email template key %s before capture", async (template) => {
    const templates = {
      known: {
        component: () => createElement("p", null, "known"),
        defaultSubject: "Known",
      },
    } as unknown as TemplateRegistry;
    const journey = defineJourney({
      meta: meta(`template-${template}`),
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: template as never,
        });
      },
    });
    const test = createJourneyTest(journey, { user, templates });

    await expect(test.run()).rejects.toThrow(
      `Email template "${template}" is not registered`,
    );
    expect(test.mailbox).toHaveLength(0);
  });

  it("deduplicates explicit email, SMS, and feed keys", async () => {
    const results: unknown[] = [];
    const journey = defineJourney({
      meta: meta("explicit-dedupe"),
      run: async (current) => {
        results.push(
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: "welcome" as never,
            idempotencyKey: "email-key",
          }),
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: "welcome" as never,
            idempotencyKey: "email-key",
          }),
          await sendSms({
            to: "+15551234567",
            userId: current.id,
            template: "welcome-sms" as never,
            idempotencyKey: "sms-key",
          }),
          await sendSms({
            to: "+15551234567",
            userId: current.id,
            template: "welcome-sms" as never,
            idempotencyKey: "sms-key",
          }),
          await sendFeedItem({
            recipient: { userId: current.id },
            type: "announcement",
            idempotencyKey: "feed-key",
          }),
          await sendFeedItem({
            recipient: { userId: current.id },
            type: "announcement",
            idempotencyKey: "feed-key",
          }),
        );
      },
    });
    const test = createJourneyTest(journey, { user, smsConsent: "granted" });

    await test.run();
    expect(test.mailbox).toHaveSentTimes("welcome", 1);
    expect(test.mailbox).toHaveSentTimes("welcome-sms", 1);
    expect(test.effects.feed).toHaveLength(1);
    expect(results[1]).toEqual(results[0]);
    expect(results[3]).toEqual(results[2]);
    expect(results[5]).toMatchObject({
      feedItemId: null,
      suppressed: false,
      createdAt: null,
    });
  });

  it("returns fresh snapshots for idempotent email and SMS results", async () => {
    const results: unknown[] = [];
    const journey = defineJourney({
      meta: meta("idempotent-result-snapshots"),
      run: async (current) => {
        const email = await sendEmail({
          to: current.email,
          userId: current.id,
          template: "snapshot-email-result" as never,
          idempotencyKey: "snapshot-email-key",
        });
        email.sentAt = "mutated";
        results.push(
          email,
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: "snapshot-email-result" as never,
            idempotencyKey: "snapshot-email-key",
          }),
        );

        const sms = await sendSms({
          to: "+15551234567",
          userId: current.id,
          template: "snapshot-sms-result" as never,
          idempotencyKey: "snapshot-sms-key",
        });
        sms.sentAt = "mutated";
        results.push(
          sms,
          await sendSms({
            to: "+15551234567",
            userId: current.id,
            template: "snapshot-sms-result" as never,
            idempotencyKey: "snapshot-sms-key",
          }),
        );
      },
    });
    const test = createJourneyTest(journey, {
      user,
      smsConsent: "granted",
    });

    await test.run();

    expect(results[0]).toMatchObject({ sentAt: "mutated" });
    expect(results[1]).toMatchObject({ sentAt: "2025-01-01T00:00:00.000Z" });
    expect(results[2]).toMatchObject({ sentAt: "mutated" });
    expect(results[3]).toMatchObject({ sentAt: "2025-01-01T00:00:00.000Z" });
  });

  it("snapshots nested outbound payloads at virtual send time", async () => {
    const emailProps = { nested: { value: "email-before" } };
    const smsProps = { nested: { value: "sms-before" } };
    const connectorArgs = { nested: { value: "connector-before" } };
    const feedMetadata = { nested: { value: "feed-before" } };
    const triggerProperties = { nested: { value: "trigger-before" } };
    const journey = defineJourney({
      meta: meta("effect-snapshots"),
      run: async (current, ctx) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "snapshot-email" as never,
          props: emailProps,
        });
        await sendSms({
          to: "+15551234567",
          userId: current.id,
          template: "snapshot-sms" as never,
          props: smsProps,
        });
        await sendConnectorAction({
          connectorId: "discord",
          action: "snapshot",
          args: connectorArgs,
        });
        await sendFeedItem({
          recipient: { userId: current.id },
          type: "snapshot-feed",
          metadata: feedMetadata,
        });
        await ctx.trigger({
          event: "snapshot.triggered",
          userId: current.id,
          properties: triggerProperties,
        });

        emailProps.nested.value = "email-after";
        smsProps.nested.value = "sms-after";
        connectorArgs.nested.value = "connector-after";
        feedMetadata.nested.value = "feed-after";
        triggerProperties.nested.value = "trigger-after";
      },
    });
    const test = createJourneyTest(journey, {
      user,
      smsConsent: "granted",
      connectorActions: [{ connectorId: "discord", name: "snapshot" }],
    });

    await test.run();

    expect(test.mailbox.at(0)?.props).toMatchObject({
      nested: { value: "email-before" },
    });
    expect(test.mailbox.at(1)?.props).toMatchObject({
      nested: { value: "sms-before" },
    });
    expect(test.effects.connectors[0]?.args).toEqual({
      nested: { value: "connector-before" },
    });
    expect(test.effects.feed[0]?.metadata).toEqual({
      nested: { value: "feed-before" },
    });
    expect(test.effects.triggers[0]?.properties).toEqual({
      nested: { value: "trigger-before" },
    });
  });

  it("keeps mailbox, effects, and timeline snapshots independent", async () => {
    const journey = defineJourney({
      meta: meta("independent-capture-views"),
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "independent" as never,
          props: { nested: { value: "captured" } },
        });
      },
    });
    const test = createJourneyTest(journey, { user });

    await test.run();
    const mailboxProps = test.mailbox.at(0)?.props as {
      nested: { value: string };
    };
    mailboxProps.nested.value = "mailbox-mutated";

    expect(test.effects.emails[0]?.props).toMatchObject({
      nested: { value: "captured" },
    });
    expect(
      test.timeline.find((entry) => entry.type === "email")?.props,
    ).toMatchObject({ nested: { value: "captured" } });
  });

  it("enforces meta.suppress independently for email and SMS", async () => {
    const emailResults: unknown[] = [];
    const smsResults: unknown[] = [];
    const journey = defineJourney({
      meta: { ...meta("journey-suppress"), suppress: hours(4) },
      run: async (current, ctx) => {
        emailResults.push(
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: "suppressed-email" as never,
            idempotencyLabel: "email-first",
          }),
        );
        smsResults.push(
          await sendSms({
            to: "+15551234567",
            userId: current.id,
            template: "suppressed-sms" as never,
            idempotencyLabel: "sms-first",
          }),
        );
        await ctx.sleep({ duration: hours(1), label: "inside-gap" });
        emailResults.push(
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: "suppressed-email" as never,
            idempotencyLabel: "email-second",
          }),
        );
        smsResults.push(
          await sendSms({
            to: "+15551234567",
            userId: current.id,
            template: "suppressed-sms" as never,
            idempotencyLabel: "sms-second",
          }),
        );
      },
    });
    const test = createJourneyTest(journey, { user, smsConsent: "granted" });

    await test.run();

    expect(test.mailbox).toHaveSentTimes("suppressed-email", 1);
    expect(test.mailbox).toHaveSentTimes("suppressed-sms", 1);
    expect(emailResults[1]).toMatchObject({
      emailSendId: "",
    });
    expect(smsResults[1]).toMatchObject({
      smsSendId: "",
      status: "skipped",
      reason: "journey_suppressed",
    });
    expect(
      test.timeline.filter((entry) => entry.reason === "journey_suppressed"),
    ).toHaveLength(2);
  });

  it("applies meta.suppress across seeded prior enrollments", async () => {
    const journey = defineJourney({
      meta: { ...meta("seeded-suppress"), suppress: hours(4) },
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "seeded-email" as never,
        });
        await sendSms({
          to: "+15551234567",
          userId: current.id,
          template: "seeded-sms" as never,
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: "2026-07-14T09:00:00.000Z",
      smsConsent: "granted",
      history: {
        emails: [
          {
            email: user.email,
            template: "older-template",
            sentAt: "2026-07-14T07:00:00.000Z",
            journeyId: "seeded-suppress",
          },
        ],
        sms: [
          {
            phone: "+15551234567",
            template: "older-sms-template",
            sentAt: "2026-07-14T07:00:00.000Z",
            journeyId: "seeded-suppress",
          },
        ],
      },
    });

    await test.run();

    expect(test.mailbox).toHaveLength(0);
    expect(
      test.timeline.filter((entry) => entry.reason === "journey_suppressed"),
    ).toHaveLength(2);
  });

  it("validates SMS templates when a registry is supplied", async () => {
    const smsTemplates = {
      known: {
        component: () => createElement("p", null, "known"),
        category: "journey",
      },
    };
    const journey = defineJourney({
      meta: meta("sms-template-validation"),
      run: async (current) => {
        await sendSms({
          to: "+15551234567",
          userId: current.id,
          template: "missing" as never,
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      smsTemplates,
      smsConsent: "granted",
    });

    await expect(test.run()).rejects.toThrow(
      'SMS template "missing" is not registered',
    );
    expect(test.mailbox).toHaveLength(0);
  });

  it("fails closed when SMS consent was not explicitly granted", async () => {
    let result: unknown;
    const journey = defineJourney({
      meta: meta("sms-consent"),
      run: async (current) => {
        result = await sendSms({
          to: "+15551234567",
          userId: current.id,
          template: "consent-sms" as never,
        });
      },
    });
    const test = createJourneyTest(journey, { user });

    await test.run();

    expect(result).toMatchObject({ status: "no_consent" });
    expect(test.mailbox).toHaveLength(0);
  });

  it("uses virtual time for stable unsubscribe URLs and rendered HTML", async () => {
    vi.stubEnv("API_PUBLIC_URL", "https://hogsend.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-32-characters-long");
    vi.useFakeTimers();

    const templates = {
      welcome: {
        component: (props: { unsubscribeUrl?: string }) =>
          createElement("a", { href: props.unsubscribeUrl }, "Unsubscribe"),
        defaultSubject: "Welcome",
      },
    } as unknown as TemplateRegistry;
    const journey = defineJourney({
      meta: meta("stable-render"),
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "welcome" as never,
        });
      },
    });

    vi.setSystemTime("2030-01-01T00:00:00.000Z");
    const first = createJourneyTest(journey, {
      user,
      now: "2026-07-14T09:00:00.000Z",
      templates,
    });
    await first.run();

    vi.setSystemTime("2040-01-01T00:00:00.000Z");
    const second = createJourneyTest(journey, {
      user,
      now: "2026-07-14T09:00:00.000Z",
      templates,
    });
    await second.run();

    expect(first.mailbox.at(0)?.props.unsubscribeUrl).toBe(
      second.mailbox.at(0)?.props.unsubscribeUrl,
    );
    const [firstRender, secondRender] = await Promise.all([
      first.mailbox.renderEmail("welcome"),
      second.mailbox.renderEmail("welcome"),
    ]);
    expect(firstRender.html).toBe(secondRender.html);
  });

  it("enforces pure feed recipient and connector registration validation", async () => {
    const badFeed = defineJourney({
      meta: meta("bad-feed"),
      run: async () => {
        await sendFeedItem({ recipient: {}, type: "announcement" });
      },
    });
    await expect(createJourneyTest(badFeed, { user }).run()).rejects.toThrow(
      "requires at least one of userId, email, anonymousId, discordId",
    );

    const badConnector = defineJourney({
      meta: meta("bad-connector"),
      run: async () => {
        await sendConnectorAction({
          connectorId: "discord",
          action: "typo",
        });
      },
    });
    await expect(
      createJourneyTest(badConnector, { user, connectorActions: [] }).run(),
    ).rejects.toThrow('no connector action "discord:typo" is registered');
  });

  it("gates recipient effects after a scheduled global unsubscribe", async () => {
    const results: unknown[] = [];
    const journey = defineJourney({
      meta: meta("delivery-gates"),
      run: async (current, ctx) => {
        await ctx.sleep({ duration: hours(2), label: "after-opt-out" });
        results.push(
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: "after-opt-out" as never,
          }),
          await sendSms({
            to: "+15551234567",
            userId: current.id,
            template: "after-opt-out-sms" as never,
          }),
          await sendFeedItem({
            recipient: { userId: current.id },
            type: "after-opt-out",
          }),
          await sendConnectorAction({
            connectorId: "discord",
            action: "sendDm",
            args: { member: current.id },
          }),
        );
      },
    });
    const test = createJourneyTest(journey, {
      user,
      connectorActions: [
        {
          connectorId: "discord",
          name: "sendDm",
          audience: { kind: "member" },
        },
      ],
    });
    test.guard.after(hours(1), false);

    await test.run();
    expect(test.mailbox).toHaveLength(0);
    expect(test.effects.feed).toHaveLength(0);
    expect(test.effects.connectors).toHaveLength(0);
    expect(results[1]).toMatchObject({ status: "unsubscribed" });
    expect(results[2]).toMatchObject({ suppressed: true });
    expect(results[3]).toMatchObject({
      skipped: true,
      reason: "unsubscribed_all",
    });
    expect(
      test.timeline.filter((entry) => entry.status === "unsubscribed"),
    ).toHaveLength(2);
  });

  it("models email, SMS, feed, and connector category opt-outs", async () => {
    const results: unknown[] = [];
    const journey = defineJourney({
      meta: { ...meta("category-gates"), category: "product" },
      run: async (current) => {
        results.push(
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: "category-email" as never,
          }),
          await sendSms({
            to: "+15551234567",
            userId: current.id,
            template: "category-sms" as never,
          }),
          await sendFeedItem({
            recipient: { userId: current.id },
            type: "category-feed",
          }),
          await sendConnectorAction({
            connectorId: "discord",
            action: "sendDm",
            args: { member: current.id },
          }),
        );
      },
    });
    const test = createJourneyTest(journey, {
      user,
      smsConsent: "granted",
      preferences: {
        categories: { product: false, in_app: false, discord: false },
      },
      connectorActions: [
        {
          connectorId: "discord",
          name: "sendDm",
          audience: { kind: "member" },
        },
      ],
    });

    await test.run();

    expect(test.mailbox).toHaveLength(0);
    expect(test.effects.feed).toHaveLength(0);
    expect(test.effects.connectors).toHaveLength(0);
    expect(results[1]).toMatchObject({ status: "unsubscribed" });
    expect(results[2]).toMatchObject({ suppressed: true });
    expect(results[3]).toMatchObject({
      skipped: true,
      reason: "channel_unsubscribed",
    });
    expect(test.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "email",
          reason: "category_unsubscribed",
        }),
        expect.objectContaining({
          type: "sms",
          reason: "category_unsubscribed",
        }),
        expect.objectContaining({
          type: "feed",
          reason: "channel_unsubscribed",
        }),
        expect.objectContaining({
          type: "connector",
          reason: "channel_unsubscribed",
        }),
      ]),
    );
  });

  it("models hard email suppression and transactional SMS consent exemption", async () => {
    let smsResult: unknown;
    const journey = defineJourney({
      meta: { ...meta("transport-gates"), category: "transactional" },
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "hard-suppressed" as never,
        });
        smsResult = await sendSms({
          to: "+15551234567",
          userId: current.id,
          template: "transactional-sms" as never,
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      preferences: { suppressed: true },
    });

    await test.run();

    expect(test.mailbox).not.toHaveSent("hard-suppressed");
    expect(test.mailbox).toHaveSent("transactional-sms");
    expect(smsResult).toMatchObject({ status: "sent" });
    expect(test.timeline).toContainEqual(
      expect.objectContaining({ type: "email", reason: "suppressed" }),
    );

    const stopped = createJourneyTest(journey, {
      user,
      smsConsent: "suppressed",
    });
    await stopped.run();
    expect(stopped.mailbox).not.toHaveSent("transactional-sms");
    expect(smsResult).toMatchObject({ status: "suppressed" });
  });

  it("honors opt-in list polarity and an explicit grant", async () => {
    const journey = defineJourney({
      meta: { ...meta("opt-in-list"), category: "product-updates" },
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "product-update" as never,
        });
      },
    });
    const blocked = createJourneyTest(journey, {
      user,
      preferences: {
        defaultOptIn: { "product-updates": false },
      },
    });
    const granted = createJourneyTest(journey, {
      user: { ...user, id: "u2" },
      preferences: {
        defaultOptIn: { "product-updates": false },
        categories: { "product-updates": true },
      },
    });

    await Promise.all([blocked.run(), granted.run()]);

    expect(blocked.mailbox).not.toHaveSent("product-update");
    expect(blocked.timeline).toContainEqual(
      expect.objectContaining({
        type: "email",
        reason: "category_unsubscribed",
      }),
    );
    expect(granted.mailbox).toHaveSent("product-update");
  });

  it("does not apply enrolled-user preferences to anonymous-only feed recipients", async () => {
    let result: unknown;
    const journey = defineJourney({
      meta: meta("anonymous-feed"),
      run: async () => {
        result = await sendFeedItem({
          recipient: { anonymousId: "anon-1" },
          type: "anonymous-announcement",
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      subscribed: false,
      preferences: { categories: { in_app: false } },
    });

    await test.run();

    expect(result).toMatchObject({ suppressed: false });
    expect(test.effects.feed).toHaveLength(1);
  });

  it("returns a configured connector result without invoking the plugin", async () => {
    let result: unknown;
    const journey = defineJourney({
      meta: meta("connector-result"),
      run: async () => {
        result = await sendConnectorAction({
          connectorId: "discord",
          action: "post",
          args: { content: "hello" },
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      connectorActions: [
        {
          connectorId: "discord",
          name: "post",
          result: (args) => ({ delivered: true, args }),
        },
      ],
    });

    await test.run();
    expect(result).toEqual({ delivered: true, args: { content: "hello" } });
    expect(test.effects.connectors).toHaveLength(1);
  });
});
