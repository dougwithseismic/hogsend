import type {
  SmsEvent,
  SmsEventType,
  SmsProvider,
  SmsWebhookHandlerMap,
} from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { smsSends, smsSuppressions } from "@hogsend/db";
import {
  countSmsSegments,
  getSmsTemplate,
  renderSmsToText,
  type SmsTemplateName,
} from "@hogsend/sms";
import { eq } from "drizzle-orm";
import { hatchet } from "./hatchet.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import { handleInboundSms } from "./sms-inbound.js";
import type {
  SmsService,
  SmsServiceConfig,
  SmsServiceRenderOptions,
  SmsServiceRenderResult,
  SmsServiceSendOptions,
  SmsServiceWebhookResult,
  SmsTrackedSendResult,
} from "./sms-service-types.js";
import { sendTrackedSms } from "./sms-tracked.js";

const emitLogger = createLogger(process.env.LOG_LEVEL);

/** SMS event → the `sms_sends` timestamp column + status string it sets. */
const WEBHOOK_TO_SMS_STATUS: Partial<
  Record<
    SmsEventType,
    { field: "sentAt" | "deliveredAt" | "failedAt"; status: string }
  >
> = {
  "sms.sent": { field: "sentAt", status: "sent" },
  "sms.delivered": { field: "deliveredAt", status: "delivered" },
  "sms.failed": { field: "failedAt", status: "failed" },
};

/**
 * The engine-owned high-level SMS sender. Owns the full pipeline — render →
 * preference/suppression check → `sms_sends` insert → `provider.send` → status
 * record — and delegates only raw delivery + webhook parse/verify to the
 * injected {@link SmsProvider}. The SMS sibling of `createTrackedMailer`.
 */
export function createTrackedSmsSender(
  config: SmsServiceConfig,
  deps: { provider: SmsProvider },
): SmsService {
  const { provider } = deps;
  const db = config.db as Database | undefined;
  const registry = config.templates;
  const logger = config.logger ?? emitLogger;

  function resolveFrom(overrideFrom?: string): string {
    const from = overrideFrom ?? config.defaultFrom;
    if (!from) {
      throw new Error(
        "SMS send requires a `from` number — set SMS_FROM / sms.from, or pin a Twilio messaging service.",
      );
    }
    return from;
  }

  const service: SmsService = {
    async send<K extends SmsTemplateName>(
      options: SmsServiceSendOptions<K>,
    ): Promise<SmsTrackedSendResult> {
      const from = resolveFrom(options.from);
      if (db) {
        return sendTrackedSms({
          db,
          provider,
          registry,
          frequencyCap: config.frequencyCap,
          logger: config.logger,
          stopFooter: config.stopFooter,
          options: {
            templateKey: options.template,
            props: options.props,
            from,
            to: options.to,
            journeyStateId: options.journeyStateId,
            userId: options.userId,
            category: options.category,
            skipPreferenceCheck: options.skipPreferenceCheck,
            idempotencyKey: options.idempotencyKey,
          },
        });
      }

      // No-db fallback (tests / bare instance): render + send, no tracking row.
      const { element } = getSmsTemplate({
        key: options.template,
        props: options.props,
        registry,
      });
      const body = await renderSmsToText(element);
      const result = await provider.send({ from, to: options.to, body });
      return { smsSendId: "", messageId: result.id, status: "sent" };
    },

    async sendRaw(options): Promise<{ id: string }> {
      return provider.send({ ...options, from: resolveFrom(options.from) });
    },

    async render<K extends SmsTemplateName>(
      options: SmsServiceRenderOptions<K>,
    ): Promise<SmsServiceRenderResult> {
      const { element, category } = getSmsTemplate({
        key: options.template,
        props: options.props,
        registry,
      });
      const text = await renderSmsToText(element);
      return { text, category, segments: countSmsSegments(text).segments };
    },

    async handleWebhook(
      event: SmsEvent,
      _providerId?: string,
    ): Promise<SmsServiceWebhookResult> {
      const userHandlers: SmsWebhookHandlerMap = config.webhookHandlers ?? {};
      const handled = await dispatchSmsWebhook(event, userHandlers);
      return { type: event.type, handled };
    },
  };

  async function dispatchSmsWebhook(
    event: SmsEvent,
    userHandlers: SmsWebhookHandlerMap,
  ): Promise<boolean> {
    switch (event.type) {
      case "sms.sent":
        // First-party `sms.sent` already emitted from the tracked sender — the
        // provider echo only updates DB status.
        await updateSmsStatus(event.type, event.messageId);
        break;
      case "sms.delivered":
        await updateSmsStatus(event.type, event.messageId);
        // Provider webhook is the SINGLE source for delivered (no first-party
        // signal) — emit outbound.
        await emitProviderSmsEvent("sms.delivered", event.messageId);
        break;
      case "sms.failed":
        await updateSmsStatus(event.type, event.messageId, {
          errorCode: event.failure?.code,
          errorReason: event.failure?.reason,
        });
        await emitProviderSmsEvent("sms.failed", event.messageId, {
          errorCode: event.failure?.code,
          errorReason: event.failure?.reason,
        });
        // A permanent carrier failure auto-suppresses the number (mirrors email
        // permanent-bounce auto-suppress) so we stop paying to text a dead line.
        if (event.failure?.class === "permanent") {
          await suppressPermanent(event.phone);
        }
        break;
      case "sms.inbound":
        if (db) {
          await handleInboundSms(event, {
            db,
            provider,
            logger,
            optOutReplies: config.optOutReplies,
            from: config.defaultFrom,
          });
        }
        break;
    }

    const userHandler = userHandlers[event.type] as
      | ((e: SmsEvent) => void | Promise<void>)
      | undefined;
    if (userHandler) {
      await userHandler(event);
      return true;
    }
    return false;
  }

  async function updateSmsStatus(
    eventType: SmsEventType,
    messageId: string,
    extra?: { errorCode?: string; errorReason?: string },
  ): Promise<void> {
    if (!db || !messageId) return;
    const mapping = WEBHOOK_TO_SMS_STATUS[eventType];
    if (!mapping) return;
    await db
      .update(smsSends)
      .set({
        status: mapping.status as typeof smsSends.$inferSelect.status,
        [mapping.field]: new Date(),
        ...(extra?.errorCode ? { errorCode: extra.errorCode } : {}),
        ...(extra?.errorReason ? { errorReason: extra.errorReason } : {}),
        updatedAt: new Date(),
      })
      .where(eq(smsSends.messageId, messageId));
  }

  async function suppressPermanent(phone: string): Promise<void> {
    if (!db) return;
    const now = new Date();
    await db
      .insert(smsSuppressions)
      .values({ phone, reason: "carrier_permanent", suppressedAt: now })
      .onConflictDoUpdate({
        target: smsSuppressions.phone,
        set: {
          reason: "carrier_permanent",
          suppressedAt: now,
          resubscribedAt: null,
          updatedAt: now,
        },
      });
  }

  function emitProviderSmsEvent(
    event: "sms.delivered" | "sms.failed",
    messageId: string,
    extra?: { errorCode?: string; errorReason?: string },
  ): void {
    if (!db) return;
    const database = db;
    void resolveSmsSendByMessageId(database, messageId)
      .then((ctx) => {
        if (!ctx) return;
        const base = {
          smsSendId: ctx.smsSendId,
          messageId,
          templateKey: ctx.templateKey,
          userId: ctx.userId,
          to: ctx.toPhone,
          at: new Date().toISOString(),
        };
        if (event === "sms.failed") {
          return emitOutbound({
            db: database,
            hatchet,
            logger,
            event: "sms.failed",
            payload: {
              ...base,
              ...(extra?.errorCode ? { errorCode: extra.errorCode } : {}),
              ...(extra?.errorReason ? { errorReason: extra.errorReason } : {}),
            },
          });
        }
        return emitOutbound({
          db: database,
          hatchet,
          logger,
          event: "sms.delivered",
          payload: base,
        });
      })
      .catch((err: unknown) => {
        logger.warn(`emitOutbound ${event} failed`, {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return service;
}

interface SmsSendByMessageId {
  smsSendId: string;
  templateKey: string | null;
  userId: string | null;
  toPhone: string;
}

/** Resolve a send row by the provider message id (the only webhook handle). */
async function resolveSmsSendByMessageId(
  db: Database,
  messageId: string,
): Promise<SmsSendByMessageId | null> {
  const rows = await db
    .select({
      smsSendId: smsSends.id,
      templateKey: smsSends.templateKey,
      userId: smsSends.userId,
      toPhone: smsSends.toPhone,
    })
    .from(smsSends)
    .where(eq(smsSends.messageId, messageId))
    .limit(1);
  return rows[0] ?? null;
}
