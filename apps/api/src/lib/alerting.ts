import {
  alertHistory,
  alertRules,
  type Database,
  journeyStates,
} from "@hogsend/db";
import { and, count, eq, gte } from "drizzle-orm";
import { getEmailStats } from "./email-stats.js";
import type { Logger } from "./logger.js";
import {
  sendEmailNotification,
  sendSlackNotification,
  sendWebhook,
} from "./notifications.js";

async function dispatchAlert(opts: {
  rule: typeof alertRules.$inferSelect;
  message: string;
  payload: Record<string, unknown>;
  resendApiKey?: string;
}): Promise<{ deliveryStatus: string; error?: string }> {
  const config = opts.rule.channelConfig as Record<string, string>;
  switch (opts.rule.channel) {
    case "webhook": {
      const result = await sendWebhook(config.url ?? "", {
        rule: opts.rule.name,
        type: opts.rule.type,
        ...opts.payload,
      });
      return result.ok
        ? { deliveryStatus: "sent" }
        : { deliveryStatus: "failed", error: result.error };
    }
    case "slack": {
      const result = await sendSlackNotification(
        config.webhookUrl ?? "",
        opts.message,
      );
      return result.ok
        ? { deliveryStatus: "sent" }
        : { deliveryStatus: "failed", error: result.error };
    }
    case "email": {
      const result = await sendEmailNotification({
        to: config.to ?? "",
        subject: `[Hogsend Alert] ${opts.rule.name}`,
        body: `<p>${opts.message}</p><pre>${JSON.stringify(opts.payload, null, 2)}</pre>`,
        resendApiKey: opts.resendApiKey ?? "",
      });
      return result.ok
        ? { deliveryStatus: "sent" }
        : { deliveryStatus: "failed", error: result.error };
    }
    default:
      return {
        deliveryStatus: "failed",
        error: `Unknown channel: ${opts.rule.channel}`,
      };
  }
}

export async function checkAlertRules(opts: {
  db: Database;
  logger: Logger;
  resendApiKey?: string;
}): Promise<void> {
  const { db, logger } = opts;

  const rules = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.enabled, true));

  for (const rule of rules) {
    try {
      if (rule.lastFiredAt) {
        const cooldownMs = rule.cooldownMinutes * 60 * 1000;
        if (Date.now() - rule.lastFiredAt.getTime() < cooldownMs) {
          continue;
        }
      }

      const threshold = rule.threshold as Record<string, number>;
      let triggered = false;
      let payload: Record<string, unknown> = {};

      switch (rule.type) {
        case "bounce_rate_exceeded": {
          const windowMinutes = threshold.windowMinutes ?? 60;
          const since = new Date(Date.now() - windowMinutes * 60 * 1000);
          const stats = await getEmailStats({ db, since });
          const rate = stats.total > 0 ? stats.bounced / stats.total : 0;
          const maxRate = threshold.rate ?? 0.05;
          if (rate > maxRate && stats.total >= 10) {
            triggered = true;
            payload = {
              bounced: stats.bounced,
              total: stats.total,
              rate,
              threshold: maxRate,
            };
          }
          break;
        }

        case "journey_failure_spike": {
          const windowMinutes = threshold.windowMinutes ?? 60;
          const maxFailures = threshold.count ?? 5;
          const since = new Date(Date.now() - windowMinutes * 60 * 1000);
          const failures = await db
            .select({ count: count() })
            .from(journeyStates)
            .where(
              and(
                eq(journeyStates.status, "failed"),
                gte(journeyStates.createdAt, since),
              ),
            )
            .then((r) => r[0]?.count ?? 0);
          if (failures >= maxFailures) {
            triggered = true;
            payload = {
              failures,
              threshold: maxFailures,
              windowMinutes,
            };
          }
          break;
        }

        case "delivery_issue": {
          const windowMinutes = threshold.windowMinutes ?? 60;
          const since = new Date(Date.now() - windowMinutes * 60 * 1000);
          const stats = await getEmailStats({ db, since });
          const deliveryRate =
            stats.total > 0 ? stats.delivered / stats.total : 1;
          const minRate = threshold.minDeliveryRate ?? 0.9;
          if (deliveryRate < minRate && stats.total >= 10) {
            triggered = true;
            payload = {
              delivered: stats.delivered,
              total: stats.total,
              deliveryRate,
              threshold: minRate,
            };
          }
          break;
        }

        case "high_complaint_rate": {
          const windowMinutes = threshold.windowMinutes ?? 60;
          const since = new Date(Date.now() - windowMinutes * 60 * 1000);
          const stats = await getEmailStats({ db, since });
          const rate = stats.total > 0 ? stats.complained / stats.total : 0;
          const maxRate = threshold.rate ?? 0.01;
          if (rate > maxRate && stats.total >= 10) {
            triggered = true;
            payload = {
              complained: stats.complained,
              total: stats.total,
              rate,
              threshold: maxRate,
            };
          }
          break;
        }
      }

      if (!triggered) continue;

      const message = `[Hogsend Alert] ${rule.name}: ${rule.type} triggered — ${JSON.stringify(payload)}`;

      const { deliveryStatus, error } = await dispatchAlert({
        rule,
        message,
        payload,
        resendApiKey: opts.resendApiKey,
      });

      await Promise.all([
        db.insert(alertHistory).values({
          alertRuleId: rule.id,
          payload,
          deliveryStatus,
          error: error ?? null,
        }),
        db
          .update(alertRules)
          .set({ lastFiredAt: new Date(), updatedAt: new Date() })
          .where(eq(alertRules.id, rule.id)),
      ]);

      logger.info("Alert fired", {
        rule: rule.name,
        type: rule.type,
        deliveryStatus,
      });
    } catch (err) {
      logger.error("Alert evaluation failed", {
        ruleId: rule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
