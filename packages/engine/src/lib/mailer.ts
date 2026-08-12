import type {
  BatchEmailItem,
  EmailEvent,
  EmailEventType,
  EmailProvider,
  WebhookHandlerMap,
} from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  TemplateName,
} from "@hogsend/email";
import { getTemplate, renderToHtml, renderToPlainText } from "@hogsend/email";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { assertAttachmentsSendable } from "./attachments.js";
import type { DomainStatusService } from "./domain-status.js";
import {
  type EmailService,
  type EmailServiceConfig,
  type EmailServiceSendOptions,
  type EmailServiceWebhookResult,
  type SendRawOptions,
  type SendResult,
  type TrackedSendResult,
  trackedSendResult,
} from "./email-service-types.js";
import { hatchet } from "./hatchet.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import {
  buildRedirect,
  isUnaddressable,
  logRedirect,
  NO_REDIRECT_MESSAGE,
  resolveTestMode,
  TestModeNoRedirectError,
} from "./test-mode.js";
import type { PrepareTrackedHtmlFn } from "./tracked.js";
import {
  providerConsumesIdempotencyKey,
  sendTrackedEmail,
  withIdempotencyHeader,
} from "./tracked.js";
import { EMAIL_REPLIED } from "./tracking-event-names.js";
import {
  type PushTrackingEventOpts,
  pushTrackingEvent,
  resolveEmailSendContextByMessageId,
} from "./tracking-events.js";

// Fallback logger for the provider-webhook outbound emit — `config.logger` is
// optional, but `emitOutbound` requires one. Mirrors the engine-lib singleton
// pattern (define-journey, preferences, tracked).
const emitLogger = createLogger(process.env.LOG_LEVEL);

const WEBHOOK_TO_STATUS_FIELD: Partial<
  Record<EmailEventType, keyof typeof emailSends.$inferSelect>
> = {
  "email.sent": "sentAt",
  "email.delivered": "deliveredAt",
  "email.opened": "openedAt",
  "email.clicked": "clickedAt",
  "email.bounced": "bouncedAt",
  "email.complained": "complainedAt",
};

const WEBHOOK_TO_STATUS: Partial<Record<EmailEventType, string>> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  /**
   * TERMINAL (PRD 18). The provider accepted the message, returned an id, and
   * then discarded it — no delivery, no bounce, no later event of any kind is
   * coming, so a row left at `sent` would stay non-terminal forever.
   *
   * `failed` rather than `bounced`, deliberately: `bounced` carries a
   * classification the engine SUPPRESSES on, and a reject is our content
   * failing rather than the recipient's address. It has no timestamp column of
   * its own and none is invented here — `updatedAt` is when we learned, and the
   * verbatim reason reaches the consumer on the event (`EmailEvent.reject`).
   */
  "email.rejected": "failed",
};

/** Max recipients we will iterate on a bounce/complaint, to avoid a fan-out
 * webhook mass-suppressing addresses. Above this we log + skip suppression. */
const MAX_SUPPRESSION_RECIPIENTS = 100;

/**
 * See `createTrackedMailer`'s `pushReplyEvent` dep.
 *
 * `registry` is deliberately NOT part of this signature. The real push needs
 * the journey registry, which lives in a process singleton that THROWS when it
 * has not been set — so reading it at the call site would make every injected
 * override depend on a global the override does not use. The default wrapper
 * reads it, and only it.
 */
export type PushReplyEventFn = (
  opts: Omit<PushTrackingEventOpts, "registry">,
) => Promise<unknown>;

/**
 * The bus event's properties — the EARS list ("the in-reply-to id, the sender,
 * and a text body") plus the context a journey needs to branch.
 *
 * Every value is a SCALAR or null, deliberately: `trigger.where` and
 * `ctx.waitForEvent(...).properties` only carry scalars, so a nested object
 * here would simply not survive to the journey that needs it.
 */
function replyProperties(
  event: EmailEvent,
  reply: NonNullable<EmailEvent["reply"]>,
): Record<string, unknown> {
  return {
    /** The RECEIVED message's own id. */
    messageId: event.messageId,
    inReplyTo: reply.inReplyTo ?? null,
    correlated: reply.correlated,
    from: reply.from,
    subject: reply.subject,
    text: reply.text,
    textTruncated: reply.textTruncated,
    recipient: reply.recipient,
  };
}

/**
 * The engine-owned high-level mailer. It owns the full send pipeline —
 * render → preference/suppression check → tracked-html rewrite → `email_sends`
 * insert → `provider.send(...)` → status record — and delegates only the raw
 * provider delivery + webhook parse/verify to the injected {@link EmailProvider}.
 */
export function createTrackedMailer(
  config: EmailServiceConfig,
  deps: {
    provider: EmailProvider;
    prepareTrackedHtml?: PrepareTrackedHtmlFn;
    /**
     * Cached sending-domain status, injected by the container. Drives test-mode
     * redirect: when `testModeCached().active`, every send is redirected to the
     * safe inbox before reaching the provider. OPTIONAL — direct construction
     * without it (tests) keeps today's behavior; the container always passes it.
     */
    domainStatus?: DomainStatusService;
    /**
     * The INTERNAL bus push used by the `email.replied` path. Defaults to the
     * real {@link pushTrackingEvent}, which resolves identity and pushes the
     * event through `ingestEvent` so a journey can `ctx.waitForEvent` on it.
     *
     * Injectable for the same reason `prepareTrackedHtml` is: the default
     * reaches the identity resolver and Hatchet, and a test asserting WHAT the
     * mailer hands the bus should not have to stand up either.
     */
    pushReplyEvent?: PushReplyEventFn;
  },
): EmailService {
  const { provider, domainStatus } = deps;
  const pushReplyEvent: PushReplyEventFn =
    deps.pushReplyEvent ??
    ((opts) =>
      pushTrackingEvent({ ...opts, registry: getJourneyRegistrySingleton() }));
  const db = config.db as Database | undefined;
  const retryDefaults = config.retryOptions;
  const registry = config.templates;
  const logger = config.logger ?? emitLogger;

  function resolveFrom(overrideFrom?: string): string {
    return overrideFrom ?? config.defaultFrom;
  }

  /**
   * Drop `scheduledAt` unless the active provider declares
   * `capabilities.scheduledSend`. A provider that can't natively schedule (e.g.
   * Postmark/SES) would silently ignore it — so the engine strips it and logs a
   * WARN pointing at the durable alternative (`ctx.sleepUntil`).
   */
  function applyScheduledAtGate<T extends { scheduledAt?: string }>(
    opts: T,
  ): T {
    if (opts.scheduledAt && provider.capabilities?.scheduledSend !== true) {
      (config.logger ?? emitLogger).warn(
        `scheduledAt ignored: provider ${
          provider.meta?.id ?? "resend"
        } has no native scheduled send; use ctx.sleepUntil`,
      );
      const { scheduledAt: _dropped, ...rest } = opts;
      return rest as T;
    }
    return opts;
  }

  const service: EmailService = {
    async send<K extends TemplateName>(
      options: EmailServiceSendOptions<K>,
    ): Promise<TrackedSendResult> {
      const from = resolveFrom(options.from);

      // Resolve test mode ONCE (cache-only, fires the fire-and-forget refresh).
      // The DB path threads the resolved state into sendTrackedEmail so
      // tracked.ts stays domainStatus-unaware; the no-db path applies it inline.
      const testMode = resolveTestMode(domainStatus);

      if (db) {
        return sendTrackedEmail({
          db,
          provider,
          registry,
          retryOptions: retryDefaults,
          prepareTrackedHtml: deps.prepareTrackedHtml,
          frequencyCap: config.frequencyCap,
          logger: config.logger,
          testMode,
          options: {
            templateKey: options.template,
            props: options.props,
            from,
            to: options.to,
            subject: options.subject,
            journeyStateId: options.journeyStateId,
            campaignId: options.campaignId,
            userId: options.userId,
            userEmail: options.userEmail,
            category: options.category,
            tags: options.tags,
            headers: options.headers,
            replyTo: options.replyTo,
            skipPreferenceCheck: options.skipPreferenceCheck,
            idempotencyKey: options.idempotencyKey,
            baseUrl: config.baseUrl,
            attachments: options.attachments,
          },
        });
      }

      // No-db attachment gate (the db path guards inside sendTrackedEmailInner,
      // before any row is written): validate + capability-check BEFORE render or
      // provider dispatch — never send the message without its files.
      if (options.attachments?.length) {
        assertAttachmentsSendable(provider, options.attachments);
      }

      const { element, subject: defaultSubject } = getTemplate({
        key: options.template,
        props: options.props,
        registry,
      });
      const subject = options.subject ?? defaultSubject;
      // HTML-ONLY wire — the engine ALWAYS renders React → HTML itself before
      // the provider. React Email stays first-class for authoring/Studio; it
      // never crosses the provider boundary.
      const html = await renderToHtml(element);

      // Test-mode redirect on the no-db path. Hard-fail (no row to write here)
      // by returning a skipped result rather than reaching the real recipient.
      let wireTo: string | string[] = options.to;
      let wireSubject = subject;
      let wireFrom = from;
      if (testMode) {
        if (isUnaddressable(testMode)) {
          logger.error(NO_REDIRECT_MESSAGE, { originalTo: options.to });
          return trackedSendResult({
            emailSendId: "",
            messageId: "",
            status: "skipped",
            reason: "test_mode_blocked",
          });
        }
        const r = buildRedirect({
          from,
          to: options.to,
          subject,
          state: testMode,
        });
        wireTo = r.to;
        wireSubject = r.subject;
        wireFrom = r.from;
        logRedirect(logger, {
          originalTo: r.originalTo,
          redirectTo: testMode.redirectTo,
          reason: testMode.reason,
        });
      }

      const result = await provider.send({
        from: wireFrom,
        to: wireTo,
        subject: wireSubject,
        html,
        tags: options.tags,
        // Same wire contract as the tracked path (see withIdempotencyHeader):
        // the key rides as a header, and ONLY to a transport that consumes it —
        // a header-forwarding provider (Resend, Postmark) would deliver it to
        // the recipient. This no-db branch never auto-derives a journey key, so
        // only a caller-supplied one can travel here.
        headers: withIdempotencyHeader(
          options.headers,
          providerConsumesIdempotencyKey(provider)
            ? options.idempotencyKey
            : undefined,
        ),
        replyTo: options.replyTo,
        // Conditionally spread: a send with no attachments hands the provider
        // options with NO `attachments` key — byte-identical to today's wire.
        ...(options.attachments?.length
          ? { attachments: options.attachments }
          : {}),
      });

      return trackedSendResult({
        emailSendId: "",
        messageId: result.id,
        status: "sent",
      });
    },

    async sendRaw(options: SendRawOptions): Promise<SendResult> {
      // SendRawOptions IS the core wire contract (minus `from`), so attachments
      // already ride the `...gated` spreads below — the only thing missing
      // would be the gate. Validate + capability-check before anything else.
      if (options.attachments?.length) {
        assertAttachmentsSendable(provider, options.attachments);
      }
      const gated = applyScheduledAtGate(options);
      const from = resolveFrom(options.from);

      const testMode = resolveTestMode(domainStatus);
      if (testMode) {
        // Raw sends have no email_sends row to record a skip against, so an
        // unaddressable test mode THROWS loudly rather than silently delivering.
        if (isUnaddressable(testMode)) {
          logger.error(NO_REDIRECT_MESSAGE, { originalTo: gated.to });
          throw new TestModeNoRedirectError();
        }
        const r = buildRedirect({
          from,
          to: gated.to,
          cc: gated.cc,
          bcc: gated.bcc,
          subject: gated.subject,
          state: testMode,
        });
        logRedirect(logger, {
          originalTo: r.originalTo,
          redirectTo: testMode.redirectTo,
          reason: testMode.reason,
        });
        // Drop cc/bcc entirely — never leak the test mail to an original recipient.
        const { cc: _cc, bcc: _bcc, ...rest } = gated;
        return provider.send({
          ...rest,
          from: r.from,
          to: r.to,
          subject: r.subject,
        });
      }

      return provider.send({ ...gated, from });
    },

    async sendBatch(options: {
      emails: BatchEmailItem[];
    }): Promise<{ results: SendResult[] }> {
      // BatchEmailItem inherits `attachments` from the core wire contract, so
      // they already flow through the item spreads below. Gate EVERY item
      // before ANY item reaches the provider — a partial batch where later
      // items silently drop their files is exactly the failure the loud gate
      // exists to prevent.
      for (const item of options.emails) {
        if (item.attachments?.length) {
          assertAttachmentsSendable(provider, item.attachments);
        }
      }
      const testMode = resolveTestMode(domainStatus);

      if (testMode) {
        // Unaddressable ⇒ throw before any item reaches the provider.
        if (isUnaddressable(testMode)) {
          logger.error(NO_REDIRECT_MESSAGE, {
            count: options.emails.length,
          });
          throw new TestModeNoRedirectError();
        }
        // Each item gets its OWN [TEST → …] prefix; ONE structured WARN for the
        // whole batch (never N log lines for a 1000-item batch).
        const originalTos: string[] = [];
        const emails = options.emails.map((e) => {
          const from = resolveFrom(e.from);
          const r = buildRedirect({
            from,
            to: e.to,
            cc: e.cc,
            bcc: e.bcc,
            subject: e.subject,
            state: testMode,
          });
          originalTos.push(r.originalTo);
          const { cc: _cc, bcc: _bcc, ...rest } = e;
          return { ...rest, from: r.from, to: r.to, subject: r.subject };
        });
        logger.warn("email.test_mode_redirect", {
          event: "email.test_mode_redirect",
          count: emails.length,
          redirectTo: testMode.redirectTo,
          reason: testMode.reason,
          originalTo: originalTos,
        });
        return provider.sendBatch(emails);
      }

      const emails = options.emails.map((e) => ({
        ...e,
        from: resolveFrom(e.from),
      }));
      return provider.sendBatch(emails);
    },

    async render<K extends TemplateName>(
      options: EmailServiceRenderOptions<K>,
    ): Promise<EmailServiceRenderResult> {
      const { element, subject, category } = getTemplate({
        key: options.template,
        props: options.props,
        registry,
      });

      const [html, text] = await Promise.all([
        renderToHtml(element),
        renderToPlainText(element),
      ]);

      return { html, text, subject, category };
    },

    async handleWebhook(
      event: EmailEvent,
      _providerId?: string,
    ): Promise<EmailServiceWebhookResult> {
      // The route owns provider resolution + signature verification and hands us
      // an already-verified, provider-neutral EmailEvent. No secret gate here —
      // each provider owns its own webhook secret at construction time.
      const userHandlers: WebhookHandlerMap = config.webhookHandlers ?? {};
      const handled = await dispatchWebhook(event, userHandlers);
      return { type: event.type, handled };
    },
  };

  const bounceThreshold = config.bounceThreshold ?? 3;

  async function dispatchWebhook(
    event: EmailEvent,
    userHandlers: WebhookHandlerMap,
  ): Promise<boolean> {
    switch (event.type) {
      case "email.sent":
        // `email.sent` is emitted FIRST-PARTY from the tracked mailer's
        // provider-accepted branch (lib/tracked.ts) with the rich payload — the
        // provider-webhook echo only updates the DB status, it does NOT emit.
        await updateEmailStatus(event.type, event.messageId);
        break;
      case "email.delivered":
        await updateEmailStatus(event.type, event.messageId);
        // OUTBOUND `email.delivered` — the provider webhook is the SINGLE source
        // for delivered/bounced (these have no first-party signal).
        await emitProviderEmailEvent("email.delivered", event.messageId);
        break;
      case "email.opened":
      case "email.clicked":
        // First-party pixel/redirect is the SINGLE outbound emitter for
        // open/click — it now fires PER-HIT (every open/click → a delivery to
        // every destination, owner decision 1). The provider-webhook echo is
        // SUPPRESSED here: it only updates the DB status, it does NOT emit
        // outbound (no double-source). This is the outbound-echo defence for a
        // provider with native tracking left ON.
        await updateEmailStatus(event.type, event.messageId);
        break;
      case "email.bounced": {
        // `bounce.class` is stored in `bounceType`, the human reason in
        // `bounceReason`. Soft/transient bounces are recorded here too (status
        // `bounced`, `class:'transient'`) — the old transient →
        // `email.delivery_delayed` no-op is gone.
        //
        // The status write is a FIRST-TRANSITION CLAIM, not a plain SET, and
        // everything with a SIDE EFFECT hangs off whether it claimed. SNS is
        // at-least-once and the control plane re-drives a `pending` event row
        // after 60s so a bounce is never lost, so the same bounce reaches here
        // more than once — and with `bounceThreshold` at 3, three redeliveries
        // of ONE bounce would permanently suppress a perfectly deliverable
        // address, silently, with nothing the customer could undo. The emit is
        // gated for the same reason: a redelivery must not double-fire a
        // customer's destination or a journey waiting on `email.bounced`.
        const claim = await claimBounce(event);
        // `unrecorded` counts — see claimBounce. Only a proven duplicate stops.
        if (claim !== "duplicate") {
          // OUTBOUND `email.bounced` with the bounce detail (class + reason).
          await emitProviderEmailEvent("email.bounced", event.messageId, {
            bounceType: event.bounce?.class,
            bounceReason: event.bounce?.reason,
          });
          // Suppress (increment bounceCount toward threshold) ONLY on a
          // permanent bounce. Transient/unknown are recorded but never
          // auto-suppress.
          if (event.bounce?.class === "permanent") {
            await handleBounce(event.recipients);
          }
        }
        break;
      }
      case "email.complained":
        await updateEmailStatus(event.type, event.messageId);
        // OUTBOUND `email.complained` — the provider webhook is the SINGLE
        // source for complaints (no first-party signal exists).
        await emitProviderEmailEvent("email.complained", event.messageId);
        await handleComplaint(event.recipients);
        break;
      case "email.rejected":
        // TERMINAL, and SUPPRESSING NOTHING (PRD 18). The provider accepted
        // the message, returned an id, then threw it away — SES's `Reject`,
        // whose only documented reason is `Bad content` (a virus we sent).
        //
        // Note what is deliberately ABSENT below, because each omission is the
        // decision rather than an oversight:
        //  - NO `handleBounce`. The recipient's address is fine. Incrementing
        //    `bounceCount` toward the suppression threshold would let one bad
        //    attachment permanently block a deliverable address, silently, with
        //    nothing the customer could undo.
        //  - NO bounce facts on the row. A reject is not a bounce, and writing
        //    `bouncedAt` would fold it into every bounce-rate read.
        //  - NO outbound emit. The outbound catalog is mirrored by hand into
        //    `@hogsend/cli` and `@hogsend/client`, both outside this change's
        //    boundary; the `WebhookHandlerMap` slot the neutral type gets for
        //    free is the in-boundary seam for a consumer that wants to react.
        await updateEmailStatus(event.type, event.messageId);
        break;
      case "email.replied":
        // A HUMAN REPLIED (PRD 16). Note what is deliberately ABSENT, because
        // each omission is the decision rather than an oversight:
        //  - NO `updateEmailStatus`. A reply is not a delivery outcome of our
        //    send. The message it answers was delivered and stays delivered;
        //    writing a status here would overwrite a real outcome with one no
        //    send ever had, and every delivery/bounce-rate read would count it.
        //  - NO suppression of any kind. Somebody replying is the strongest
        //    evidence an address works.
        await handleReply(event);
        break;
      case "email.delivery_delayed":
        // No-op: providers now map transient bounces to `email.bounced` with
        // `class:'transient'`, so soft bounces are recorded there instead.
        break;
    }

    const userHandler = userHandlers[event.type] as
      | ((e: EmailEvent) => void | Promise<void>)
      | undefined;
    if (userHandler) {
      await userHandler(event);
      return true;
    }

    return false;
  }

  /** Recipients to actually act on: de-duped, falsy-stripped, count-capped. A
   * fan-out webhook over the cap is logged + skipped to avoid mass-suppression. */
  function validRecipients(recipients: string[]): string[] {
    const unique = [...new Set(recipients.filter(Boolean))];
    if (unique.length > MAX_SUPPRESSION_RECIPIENTS) {
      (config.logger ?? emitLogger).warn(
        "suppression skipped: recipient count exceeds cap",
        { count: unique.length, cap: MAX_SUPPRESSION_RECIPIENTS },
      );
      return [];
    }
    return unique;
  }

  /**
   * The outcome of trying to CLAIM a bounce for its send row.
   *
   *  - `first` — this delivery is the one that moved the send into this bounce
   *    state. Count it, emit it.
   *  - `duplicate` — the send is already in this bounce state, so a previous
   *    delivery already counted and emitted. Do neither again.
   *  - `unrecorded` — no `email_sends` row carries this `messageId` at all, so
   *    there is no send-scoped state to dedupe against. See {@link claimBounce}.
   */
  type BounceClaim = "first" | "duplicate" | "unrecorded";

  /**
   * Claim a bounce for its send, exactly once per (send, bounce).
   *
   * The mechanism is the codebase's existing first-transition idiom — the
   * `WHERE clickedAt IS NULL` of `routes/tracking/click-pipeline.ts` — applied
   * to the bounce leg: the status write carries a guard, and only the delivery
   * whose UPDATE actually matched a row gets to count and emit. A redelivery
   * matches nothing, writes nothing, and returns `duplicate`. It is one
   * statement, so two redeliveries racing each other still produce one winner.
   *
   * The guard admits ONE escalation, deliberately. A PERMANENT bounce is
   * refused only by a send already marked permanent (`bounce_type IS DISTINCT
   * FROM 'permanent'`, NULL-safe), so a soft bounce recorded first cannot
   * shield the hard bounce that follows it on the same message — that would
   * silently disable suppression for exactly the addresses that need it. Every
   * other class claims only the first bounce of any kind (`bounced_at IS
   * NULL`): they never count, and the guard is there to stop the emit
   * double-firing.
   *
   * WHEN NO ROW MATCHES (`unrecorded`) THE BOUNCE STILL COUNTS. That is the
   * deliberate choice, not an oversight: `sendRaw` writes no `email_sends` row
   * at all, and a provider webhook can outrun the send row's commit, so "no
   * matching row" is a REAL bounce we simply hold no state for. Dropping it
   * would turn a fix for double-counting into a silent hole in suppression for
   * those addresses, which is the worse failure. The residual is that a
   * REDELIVERED bounce for an unrecorded send is still counted twice — there is
   * nothing to key on — so it is logged rather than hidden. (The emit does not
   * double-fire there: it resolves its context from the same missing row and
   * no-ops.)
   */
  async function claimBounce(event: EmailEvent): Promise<BounceClaim> {
    // No db configured: there is no send row to claim, and both `handleBounce`
    // and `emitProviderEmailEvent` no-op without one anyway.
    if (!db) return "unrecorded";

    const guard =
      event.bounce?.class === "permanent"
        ? sql`${emailSends.bounceType} is distinct from ${"permanent"}`
        : isNull(emailSends.bouncedAt);

    const claimed = await updateEmailStatus(
      "email.bounced",
      event.messageId,
      { bounceType: event.bounce?.class, bounceReason: event.bounce?.reason },
      guard,
    );
    if (claimed > 0) return "first";

    // Nothing matched: either the send is already in this bounce state, or we
    // never recorded the send. Only the second may count, so tell them apart.
    const recorded = await resolveEmailSendContextByMessageId(
      db,
      event.messageId,
    );
    if (recorded) return "duplicate";

    (config.logger ?? emitLogger).warn(
      "bounce for an unrecorded send: counted without send-scoped dedupe",
      { messageId: event.messageId },
    );
    return "unrecorded";
  }

  async function handleBounce(recipients: string[]): Promise<void> {
    if (!db) return;
    const emails = validRecipients(recipients);
    if (emails.length === 0) return;

    // ONE statement for all recipients. The CASE-WHEN auto-suppress at threshold
    // is evaluated PER ROW inside the single UPDATE, so semantics match the old
    // per-email loop exactly.
    await db
      .update(emailPreferences)
      .set({
        bounceCount: sql`${emailPreferences.bounceCount} + 1`,
        lastBounceAt: new Date(),
        suppressed: sql`CASE WHEN ${emailPreferences.bounceCount} + 1 >= ${bounceThreshold} THEN true ELSE ${emailPreferences.suppressed} END`,
        suppressedAt: sql`CASE WHEN ${emailPreferences.bounceCount} + 1 >= ${bounceThreshold} THEN NOW() ELSE ${emailPreferences.suppressedAt} END`,
        updatedAt: new Date(),
      })
      .where(inArray(emailPreferences.email, emails));
  }

  async function handleComplaint(recipients: string[]): Promise<void> {
    if (!db) return;
    const emails = validRecipients(recipients);
    if (emails.length === 0) return;

    // ONE statement for all recipients (same semantics as the old per-email loop).
    await db
      .update(emailPreferences)
      .set({
        suppressed: true,
        suppressedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(emailPreferences.email, emails));
  }

  /**
   * Emit the provider-funnel outbound event (`email.delivered` /
   * `email.bounced` / `email.complained`) for a provider `messageId`. These three
   * have no first-party signal — the provider webhook is their single source.
   * Enriches via {@link resolveEmailSendContextByMessageId}
   * (the only handle a provider webhook holds is the message id). Fire-and-forget:
   * a missing context (webhook racing the send-row commit) or a transient outbound
   * error is logged and swallowed — never failing the webhook handler. No
   * `dedupeKey`: the provider path is not a Hatchet-retryable producer, and the
   * shared `Webhook-Id` is the subscriber-side dedup for any provider redelivery.
   */
  function emitProviderEmailEvent(
    event: "email.delivered" | "email.bounced" | "email.complained",
    messageId: string,
    bounce?: { bounceType?: string; bounceReason?: string },
  ): void {
    if (!db) return;
    const log = config.logger ?? emitLogger;
    const database = db;
    void resolveEmailSendContextByMessageId(database, messageId)
      .then((ctx) => {
        if (!ctx) return;
        const base = {
          emailSendId: ctx.emailSendId,
          messageId,
          templateKey: ctx.templateKey,
          userId: ctx.userId,
          to: ctx.to,
          at: new Date().toISOString(),
        };
        if (event === "email.bounced") {
          return emitOutbound({
            db: database,
            hatchet,
            logger: log,
            event: "email.bounced",
            payload: {
              ...base,
              ...(bounce?.bounceType ? { bounceType: bounce.bounceType } : {}),
              ...(bounce?.bounceReason
                ? { bounceReason: bounce.bounceReason }
                : {}),
            },
          });
        }
        if (event === "email.complained") {
          return emitOutbound({
            db: database,
            hatchet,
            logger: log,
            event: "email.complained",
            payload: base,
          });
        }
        return emitOutbound({
          db: database,
          hatchet,
          logger: log,
          event: "email.delivered",
          payload: base,
        });
      })
      .catch((err: unknown) => {
        log.warn(`emitOutbound ${event} failed`, {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * A reply, onto the internal bus and then onto the outbound spine (PRD 16).
   *
   * The ORDER is the design. The bus push is awaited and its failure
   * PROPAGATES, while the spine emit never throws by construction — because the
   * two failures are not the same failure. A journey that never learns a human
   * asked to stop keeps sending, which is the exact harm this feature exists to
   * prevent; so a failed bus push must reach the caller, where the route's
   * non-2xx tells the relay to re-drive (SNS's retry is the durable one, and
   * the idempotency key below is what makes a re-drive safe). A subscriber
   * missing one webhook is an ordinary outbound failure the delivery table
   * already retries.
   *
   * `inReplyTo` is the ONLY thing correlation is allowed to key on, and it is
   * present only when the relay proved the id belongs to a send this instance
   * made. Everything else on `reply` came out of a stranger's message.
   */
  async function handleReply(event: EmailEvent): Promise<void> {
    if (!db) return;
    const reply = event.reply;
    // A provider that named the type and carried no detail. Nothing to
    // correlate and nothing to say — better silent than inventing a payload of
    // nulls that reads like a real reply on every subscriber's dashboard.
    if (!reply) {
      (config.logger ?? emitLogger).warn(
        "email.replied arrived with no reply detail",
        { messageId: event.messageId },
      );
      return;
    }

    const ctx = reply.inReplyTo
      ? await resolveEmailSendContextByMessageId(db, reply.inReplyTo)
      : null;

    // The received message's id is stable across every SNS redelivery and
    // every relay re-drive, so it is the dedupe on BOTH legs. A duplicate
    // `email.replied` can exit a journey a second time, and an exit is not a
    // thing that can be taken back.
    const dedupeKey = `reply:${event.messageId}`;

    // UNCORRELATED replies skip this leg and only this leg: there is no contact
    // key to ingest against, and resolving one from the sender's own `From:`
    // would mint a contact out of a stranger's message (#621). The spine emit
    // below still fires, so the reply is delivered and marked uncorrelated
    // rather than dropped.
    if (ctx) {
      await pushReplyEvent({
        db,
        hatchet,
        logger: config.logger ?? emitLogger,
        event: EMAIL_REPLIED,
        emailSendId: ctx.emailSendId,
        idempotencyKey: dedupeKey,
        properties: replyProperties(event, reply),
      });
    }

    await emitOutbound({
      db,
      hatchet,
      logger: config.logger ?? emitLogger,
      event: "email.replied",
      dedupeKey,
      payload: {
        messageId: event.messageId,
        inReplyTo: reply.inReplyTo ?? null,
        correlated: reply.correlated,
        emailSendId: ctx?.emailSendId ?? null,
        templateKey: ctx?.templateKey ?? null,
        userId: ctx?.userId ?? null,
        to: ctx?.to ?? null,
        from: reply.from,
        subject: reply.subject,
        text: reply.text,
        textTruncated: reply.textTruncated,
        recipient: reply.recipient,
        at: event.occurredAt,
      },
    });
  }

  /**
   * Write the send's status for a provider webhook. Returns how many rows the
   * statement wrote, which only the guarded caller reads.
   *
   * `guard` is an EXTRA predicate ANDed onto the message-id match, which turns
   * the plain SET into a first-transition claim (see {@link claimBounce}).
   * Ungarded — every caller but the bounce leg — the write stays a plain SET
   * and so stays replay-safe by writing the same values again. Open/click in
   * particular pass no guard on purpose: their per-hit write is deliberate.
   */
  async function updateEmailStatus(
    eventType: EmailEventType,
    messageId: string,
    extra?: { bounceType?: string; bounceReason?: string },
    guard?: SQL,
  ): Promise<number> {
    if (!db) return 0;

    const timestampField = WEBHOOK_TO_STATUS_FIELD[eventType];
    const status = WEBHOOK_TO_STATUS[eventType];
    // The STATUS is what makes a row terminal; the timestamp column is
    // optional. `email.rejected` has a status and no column of its own, and
    // borrowing `bouncedAt` for it would quietly fold every reject into the
    // bounce-rate reads. Every other type still writes both.
    if (!status) return 0;

    const written = await db
      .update(emailSends)
      .set({
        status: status as typeof emailSends.$inferSelect.status,
        ...(timestampField ? { [timestampField]: new Date() } : {}),
        ...(extra?.bounceType ? { bounceType: extra.bounceType } : {}),
        ...(extra?.bounceReason ? { bounceReason: extra.bounceReason } : {}),
        updatedAt: new Date(),
      })
      .where(
        guard
          ? and(eq(emailSends.messageId, messageId), guard)
          : eq(emailSends.messageId, messageId),
      )
      .returning({ id: emailSends.id });

    return written.length;
  }

  return service;
}
