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
import { and, eq, inArray } from "drizzle-orm";
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

type SmsSendStatus = "queued" | "sent" | "delivered" | "failed";

/**
 * SMS event → the `sms_sends` timestamp column + status it sets, plus the
 * statuses it may LEGALLY transition from. Twilio status callbacks are separate
 * unordered HTTP requests (a delayed `sent` can land after `delivered`), so the
 * update is guarded monotonic: a callback that does not ADVANCE the lifecycle
 * matches zero rows and is dropped — which also makes duplicate callbacks
 * emit-once (the atomic guarded UPDATE is the dedup).
 */
const WEBHOOK_TO_SMS_STATUS: Partial<
  Record<
    SmsEventType,
    {
      field: "sentAt" | "deliveredAt" | "failedAt";
      status: SmsSendStatus;
      allowedFrom: SmsSendStatus[];
    }
  >
> = {
  "sms.sent": { field: "sentAt", status: "sent", allowedFrom: ["queued"] },
  "sms.delivered": {
    field: "deliveredAt",
    status: "delivered",
    allowedFrom: ["queued", "sent"],
  },
  "sms.failed": {
    field: "failedAt",
    status: "failed",
    allowedFrom: ["queued", "sent"],
  },
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
          testMode: config.testMode,
          testPhone: config.testPhone,
          linkTracking: config.linkTracking,
          linkHost: config.linkHost,
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
        // provider echo only updates DB status (and only from `queued`).
        await updateSmsStatus(event.type, event.messageId);
        break;
      case "sms.delivered": {
        // Provider webhook is the SINGLE source for delivered (no first-party
        // signal) — emit outbound, but only when the guarded UPDATE actually
        // advanced the row (a duplicate/late callback emits nothing).
        const ctx = await updateSmsStatus(event.type, event.messageId);
        if (ctx) {
          await emitProviderSmsEvent("sms.delivered", event.messageId, ctx);
        }
        break;
      }
      case "sms.failed": {
        const ctx = await updateSmsStatus(event.type, event.messageId, {
          errorCode: event.failure?.code,
          errorReason: event.failure?.reason,
        });
        if (ctx) {
          await emitProviderSmsEvent("sms.failed", event.messageId, ctx, {
            errorCode: event.failure?.code,
            errorReason: event.failure?.reason,
          });
        }
        // A permanent carrier failure auto-suppresses the number (mirrors email
        // permanent-bounce auto-suppress) so we stop paying to text a dead
        // line. Independent of the status guard — the suppression signal holds
        // even when callbacks arrive out of order.
        if (event.failure?.class === "permanent") {
          await suppressPermanent(event.phone);
        }
        break;
      }
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

  /**
   * Guarded-monotonic status update. Returns the advanced row's emit context,
   * or null when the callback did not advance the lifecycle (duplicate,
   * out-of-order, or unknown messageId) — the `.returning()` doubles as the
   * single query the outbound emit needs, so there is no second lookup.
   */
  async function updateSmsStatus(
    eventType: SmsEventType,
    messageId: string,
    extra?: { errorCode?: string; errorReason?: string },
  ): Promise<SmsSendEmitContext | null> {
    if (!db || !messageId) return null;
    const mapping = WEBHOOK_TO_SMS_STATUS[eventType];
    if (!mapping) return null;
    const rows = await db
      .update(smsSends)
      .set({
        status: mapping.status,
        [mapping.field]: new Date(),
        ...(extra?.errorCode ? { errorCode: extra.errorCode } : {}),
        ...(extra?.errorReason ? { errorReason: extra.errorReason } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(smsSends.messageId, messageId),
          inArray(smsSends.status, mapping.allowedFrom),
        ),
      )
      .returning({
        smsSendId: smsSends.id,
        templateKey: smsSends.templateKey,
        userId: smsSends.userId,
        toPhone: smsSends.toPhone,
      });
    return rows[0] ?? null;
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

  /**
   * Emit the single-source provider events. `sms.delivered`/`sms.failed` have
   * no first-party signal, and Twilio aggressively retries callbacks — the
   * guarded UPDATE upstream already makes this emit-once per transition, and
   * the dedupeKey backstops any endpoint-level replay.
   */
  async function emitProviderSmsEvent(
    event: "sms.delivered" | "sms.failed",
    messageId: string,
    ctx: SmsSendEmitContext,
    extra?: { errorCode?: string; errorReason?: string },
  ): Promise<void> {
    if (!db) return;
    const base = {
      smsSendId: ctx.smsSendId,
      messageId,
      templateKey: ctx.templateKey,
      userId: ctx.userId,
      to: ctx.toPhone,
      at: new Date().toISOString(),
    };
    try {
      if (event === "sms.failed") {
        await emitOutbound({
          db,
          hatchet,
          logger,
          event: "sms.failed",
          dedupeKey: `sms.failed:${ctx.smsSendId}`,
          payload: {
            ...base,
            ...(extra?.errorCode ? { errorCode: extra.errorCode } : {}),
            ...(extra?.errorReason ? { errorReason: extra.errorReason } : {}),
          },
        });
      } else {
        await emitOutbound({
          db,
          hatchet,
          logger,
          event: "sms.delivered",
          dedupeKey: `sms.delivered:${ctx.smsSendId}`,
          payload: base,
        });
      }
    } catch (err: unknown) {
      logger.warn(`emitOutbound ${event} failed`, {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return service;
}

interface SmsSendEmitContext {
  smsSendId: string;
  templateKey: string | null;
  userId: string | null;
  toPhone: string;
}
