import {
  createWhenBuilder,
  durationToMs,
  evaluatePropertyConditions,
  hours,
  normalizeWhere,
} from "@hogsend/core";
import type {
  DigestOptions,
  JourneyContext,
  JourneyUser,
  RecentEvent,
  ThrottleOptions,
  TriggerOptions,
} from "@hogsend/core/types";
import { getTemplateDefinition } from "@hogsend/email";
import type {
  JourneyBoundary,
  JourneyServiceOverrides,
} from "@hogsend/engine/testing";
import {
  deriveJourneyKey,
  evaluateEnrollmentPolicy,
  getJourneyBoundary,
  isHeldOut,
  isListSubscribed,
  JourneyExitedError,
  pickVariant,
  registerKey,
  registerRecordLabel,
  runWithJourneyBoundary,
  validateVariantArms,
  validateVariantKey,
} from "@hogsend/engine/testing";
import { getSmsTemplateDefinition } from "@hogsend/sms";
import { JourneyMailbox } from "./mailbox.js";
import type {
  CapturedTrigger,
  EntryFixtures,
  EventsController,
  EventTarget,
  GuardController,
  HistoryController,
  JourneyDefinition,
  JourneyEffects,
  JourneyTestOptions,
  MailboxMessage,
  TestEmailHistory,
  TestEvent,
  TestJourneyHistory,
  TestRecipientPreferences,
  TestSmsHistory,
  TimelineEntry,
} from "./types.js";

const DEFAULT_NOW = "2025-01-01T00:00:00.000Z";
const STATE_ID = "journey-test-state";
const RUN_ID = "journey-test-run";
const MAX_WAIT_MS = durationToMs({ hours: 720 });

type RecordNamespace =
  | "__once__"
  | "__digest__"
  | "__throttle__"
  | "__variants__";
type WaitType = "sleep" | "sleepUntil" | "waitForEvent" | "digest";
type WaitOutcome = "resumed" | "matched" | "timedOut" | "exited";

type GuardChange = {
  at: number;
  subscribed: boolean;
  sequence: number;
  reported: boolean;
};

const toDate = (value: Date | string, label: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new TypeError(`${label}: invalid date`);
  return date;
};

const scalars = (
  value: Record<string, unknown>,
): Record<string, string | number | boolean | null> =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) =>
        item === null || ["string", "number", "boolean"].includes(typeof item),
    ),
  ) as Record<string, string | number | boolean | null>;

export class JourneyTest {
  readonly options: JourneyTestOptions;
  readonly mailbox: JourneyMailbox;
  readonly timeline: TimelineEntry[] = [];
  readonly effects: JourneyEffects;
  readonly events: EventsController;
  readonly guard: GuardController;
  readonly history: HistoryController;
  readonly once: {
    set: (key: string, value: unknown) => void;
    has: (key: string) => boolean;
  };
  readonly entry: {
    check: (
      fixtures?: EntryFixtures,
    ) => ReturnType<typeof evaluateEnrollmentPolicy>;
  };
  readonly context: JourneyContext;

  private currentMs: number;
  private readonly initialMs: number;
  private sequence = 0;
  private hasRun = false;
  private readonly journalEvents: TestEvent[] = [];
  private readonly reportedEventSequences = new Set<number>();
  private readonly guardChanges: GuardChange[] = [];
  private readonly recordValues: Record<RecordNamespace, Map<string, unknown>> =
    {
      __once__: new Map(),
      __digest__: new Map(),
      __throttle__: new Map(),
      __variants__: new Map(),
    };
  private readonly pendingRecords: Record<
    RecordNamespace,
    Map<string, Promise<unknown>>
  > = {
    __once__: new Map(),
    __digest__: new Map(),
    __throttle__: new Map(),
    __variants__: new Map(),
  };
  private readonly emailHistory: TestEmailHistory[] = [];
  private readonly smsHistory: TestSmsHistory[] = [];
  private readonly journeyHistory: TestJourneyHistory[] = [];
  private readonly emailIdempotency = new Map<
    string,
    { emailSendId: string; sentAt: string }
  >();
  private readonly smsIdempotency = new Map<
    string,
    {
      smsSendId: string;
      status: "sent";
      sentAt: string;
    }
  >();
  private readonly feedIdempotency = new Map<string, string>();
  private serviceAttemptSequence = 0;
  private currentJourney: TestJourneyHistory | undefined;
  private currentLabel: string | undefined;
  private pendingExitEvent: TestEvent | undefined;
  private readonly recipientPreferences: TestRecipientPreferences;

  constructor(
    readonly journey: JourneyDefinition,
    options: JourneyTestOptions,
  ) {
    this.options = {
      ...options,
      user: {
        ...options.user,
        properties: this.jsonSnapshot(
          options.user.properties,
          "journey user properties",
        ),
      },
      ...(options.now instanceof Date ? { now: new Date(options.now) } : {}),
      ...(options.sendWindow ? { sendWindow: { ...options.sendWindow } } : {}),
      ...(options.templates
        ? { templates: this.cloneDefinitionRegistry(options.templates) }
        : {}),
      ...(options.smsTemplates
        ? { smsTemplates: this.cloneDefinitionRegistry(options.smsTemplates) }
        : {}),
      ...(options.history
        ? {
            history: this.jsonSnapshot(options.history, "history fixtures"),
          }
        : {}),
      ...(options.entry
        ? { entry: this.jsonSnapshot(options.entry, "entry fixtures") }
        : {}),
      ...(options.preferences
        ? {
            preferences: this.jsonSnapshot(
              options.preferences,
              "recipient preferences",
            ),
          }
        : {}),
      ...(options.once
        ? { once: this.jsonSnapshot(options.once, "once fixtures") }
        : {}),
      ...(options.variants
        ? { variants: this.jsonSnapshot(options.variants, "variant fixtures") }
        : {}),
      ...(options.connectorActions
        ? {
            connectorActions: options.connectorActions.map((action) => ({
              ...action,
              ...(action.audience ? { audience: { ...action.audience } } : {}),
              ...(action.result !== undefined
                ? {
                    result:
                      typeof action.result === "function"
                        ? action.result
                        : this.jsonSnapshot(
                            action.result,
                            "connector action result",
                          ),
                  }
                : {}),
            })),
          }
        : {}),
    };
    const start = toDate(
      this.options.now ?? DEFAULT_NOW,
      "createJourneyTest now",
    );
    this.currentMs = start.getTime();
    this.initialMs = this.currentMs;
    this.recipientPreferences = this.jsonSnapshot(
      this.options.preferences ?? {},
      "recipient preferences",
    );
    this.mailbox = new JourneyMailbox(this.options.templates);
    this.effects = {
      emails: [],
      sms: [],
      connectors: [],
      feed: [],
      triggers: [],
      waits: [],
      checkpoints: [],
      exits: [],
    };
    this.guardChanges.push({
      at: this.currentMs,
      subscribed: this.options.subscribed ?? true,
      sequence: this.sequence++,
      reported: true,
    });
    for (const [key, value] of Object.entries(this.options.once ?? {}))
      this.setRecord("__once__", key, value);
    for (const [key, value] of Object.entries(this.options.variants ?? {}))
      this.setRecord("__variants__", key, value);
    this.loadHistory();

    this.events = {
      emit: (event, properties, target) =>
        this.addEvent(this.currentMs, event, properties, target),
      after: (duration, event, properties, target) =>
        this.addEvent(
          this.currentMs + durationToMs(duration),
          event,
          properties,
          target,
        ),
      at: (instant, event, properties, target) =>
        this.addEvent(
          toDate(instant, "events.at").getTime(),
          event,
          properties,
          target,
        ),
    };
    this.guard = {
      isSubscribed: () => this.subscriptionAt(this.currentMs),
      setSubscribed: (subscribed) =>
        this.addGuardChange(this.currentMs, subscribed),
      after: (duration, subscribed) =>
        this.addGuardChange(
          this.currentMs + durationToMs(duration),
          subscribed,
        ),
      at: (instant, subscribed) =>
        this.addGuardChange(toDate(instant, "guard.at").getTime(), subscribed),
    };
    this.history = {
      addJourney: (fixture) =>
        this.journeyHistory.push(this.normalizeJourneyHistory(fixture)),
      addEmail: (fixture) =>
        this.emailHistory.push({
          ...fixture,
          sentAt: toDate(
            fixture.sentAt ?? this.now,
            "history.addEmail sentAt",
          ).toISOString(),
        }),
      addSms: (fixture) =>
        this.smsHistory.push({
          ...fixture,
          sentAt: toDate(
            fixture.sentAt ?? this.now,
            "history.addSms sentAt",
          ).toISOString(),
        }),
    };
    this.once = {
      set: (key, value) => this.setRecord("__once__", key, value),
      has: (key) => this.recordValues.__once__.has(key),
    };
    this.entry = { check: (fixtures) => this.checkEntry(fixtures) };
    this.context = this.createContext();
  }

  get now(): Date {
    return new Date(this.currentMs);
  }
  get virtualDurationMs(): number {
    return this.currentMs - this.initialMs;
  }

  private recordTimeline(entry: TimelineEntry): void {
    this.timeline.push(this.jsonSnapshot(entry, "timeline entry"));
    this.timeline.sort(
      (left, right) =>
        new Date(left.at).getTime() - new Date(right.at).getTime(),
    );
  }

  private cloneDefinitionRegistry<T extends object>(registry: T): T {
    return Object.fromEntries(
      Object.entries(registry).map(([key, definition]) => [
        key,
        definition && typeof definition === "object"
          ? { ...definition }
          : definition,
      ]),
    ) as T;
  }

  /** Snapshot JSON data like the production jsonb/provider boundary. */
  private jsonSnapshot<T>(value: T, label = "ctx.once values"): T {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch (error) {
      throw new TypeError(`${label} must be JSON-serializable`, {
        cause: error,
      });
    }
    if (serialized === undefined) {
      throw new TypeError(`${label} must be JSON-serializable`);
    }
    return JSON.parse(serialized) as T;
  }

  private setRecord(
    namespace: RecordNamespace,
    key: string,
    value: unknown,
  ): void {
    this.recordValues[namespace].set(key, this.jsonSnapshot(value));
  }

  /**
   * In-memory equivalent of production's first-writer-wins recordOnce.
   * Concurrent callers share the winning commit and every read is a jsonb-like
   * round-trip, so caller mutation cannot alter the recorded value.
   */
  private async recordOnce<T>(
    namespace: RecordNamespace,
    key: string,
    compute: () => Promise<T> | T,
  ): Promise<T> {
    const values = this.recordValues[namespace];
    if (values.has(key)) return this.jsonSnapshot(values.get(key)) as T;

    const pending = this.pendingRecords[namespace];
    const existing = pending.get(key);
    if (existing) return this.jsonSnapshot(await existing) as T;

    // Starting compute in a microtask lets us publish the pending record first,
    // including for a synchronous compute callback.
    const commit = Promise.resolve()
      .then(compute)
      .then((computed) => {
        const stored = this.jsonSnapshot(computed);
        if (!values.has(key)) values.set(key, stored);
        return values.get(key);
      });
    pending.set(key, commit);
    try {
      return this.jsonSnapshot(await commit) as T;
    } finally {
      if (pending.get(key) === commit) pending.delete(key);
    }
  }

  private updateCurrentJourney(
    status: NonNullable<TestJourneyHistory["status"]>,
  ): void {
    if (!this.currentJourney) return;
    this.currentJourney.status = status;
    if (status === "completed") {
      this.currentJourney.completedAt = this.now.toISOString();
    }
  }

  private captureWait(
    type: WaitType,
    at: string,
    label: string,
    outcome: WaitOutcome,
    detail: Record<string, unknown> = {},
  ): TimelineEntry {
    const record: TimelineEntry = {
      type,
      at,
      label,
      outcome,
      resumedAt: this.now.toISOString(),
      ...detail,
    };
    this.effects.waits.push(record);
    this.recordTimeline(record);
    return record;
  }

  private advanceWait(opts: {
    type: WaitType;
    at: string;
    label: string;
    targetMs: number;
    outcome: Exclude<WaitOutcome, "exited">;
    detail?: Record<string, unknown>;
  }): TimelineEntry {
    this.updateCurrentJourney("waiting");
    try {
      this.advanceTo(opts.targetMs);
      this.updateCurrentJourney("active");
      return this.captureWait(
        opts.type,
        opts.at,
        opts.label,
        opts.outcome,
        opts.detail,
      );
    } catch (error) {
      if (error instanceof JourneyExitedError) {
        this.captureWait(opts.type, opts.at, opts.label, "exited", opts.detail);
      }
      throw error;
    }
  }

  private loadHistory(): void {
    for (const event of this.options.history?.events ?? []) {
      this.journalEvents.push({
        ...event,
        properties: this.jsonSnapshot(
          event.properties ?? {},
          "history event properties",
        ),
        occurredAt: toDate(
          event.occurredAt,
          "history event occurredAt",
        ).toISOString(),
        source: event.source ?? "script",
        sequence: this.sequence++,
      });
    }
    for (const item of this.options.history?.emails ?? []) {
      this.emailHistory.push({
        ...this.jsonSnapshot(item, "email history fixture"),
        sentAt: toDate(item.sentAt, "email history sentAt").toISOString(),
      });
    }
    for (const item of this.options.history?.sms ?? []) {
      this.smsHistory.push({
        ...this.jsonSnapshot(item, "SMS history fixture"),
        sentAt: toDate(item.sentAt, "SMS history sentAt").toISOString(),
      });
    }
    for (const item of this.options.history?.journeys ?? []) {
      this.journeyHistory.push(this.normalizeJourneyHistory(item));
    }
  }

  private normalizeJourneyHistory(
    fixture: TestJourneyHistory,
  ): TestJourneyHistory {
    const snapshot = this.jsonSnapshot(fixture, "journey history fixture");
    return {
      ...snapshot,
      ...(fixture.enteredAt !== undefined
        ? {
            enteredAt: toDate(
              fixture.enteredAt,
              "journey history enteredAt",
            ).toISOString(),
          }
        : {}),
      ...(fixture.completedAt !== undefined
        ? {
            completedAt: toDate(
              fixture.completedAt,
              "journey history completedAt",
            ).toISOString(),
          }
        : {}),
    };
  }

  private addEvent(
    at: number,
    event: string,
    properties: Record<string, unknown> = {},
    target: EventTarget = {},
    source: TestEvent["source"] = "script",
  ): TestEvent {
    const record: TestEvent = {
      event,
      properties: this.jsonSnapshot(properties, "event properties"),
      userId: target.userId ?? this.options.user.id,
      ...((target.userEmail ?? this.options.user.email)
        ? { userEmail: target.userEmail ?? this.options.user.email }
        : {}),
      occurredAt: new Date(at).toISOString(),
      source,
      sequence: this.sequence++,
    };
    this.journalEvents.push(record);
    if (this.hasRun && at <= this.currentMs) {
      this.reportEvent(record);
      if (
        source !== "enrollment" &&
        record.userId === this.options.user.id &&
        this.matchesExitEvent(record)
      ) {
        this.pendingExitEvent ??= record;
      }
    }
    return this.jsonSnapshot(record, "event record");
  }

  private reportEvent(event: TestEvent): void {
    if (this.reportedEventSequences.has(event.sequence)) return;
    this.reportedEventSequences.add(event.sequence);
    this.recordTimeline({
      type: "event",
      at: event.occurredAt,
      event: event.event,
      userId: event.userId,
      properties: this.jsonSnapshot(event.properties, "event properties"),
      source: event.source,
    });
  }

  private addGuardChange(at: number, subscribed: boolean): void {
    const change: GuardChange = {
      at,
      subscribed,
      sequence: this.sequence++,
      reported: false,
    };
    this.guardChanges.push(change);
    if (at <= this.currentMs) {
      change.reported = true;
      this.recordTimeline({
        type: "guard",
        at: new Date(at).toISOString(),
        subscribed,
      });
    }
  }

  private subscriptionAt(at: number): boolean {
    return (
      [...this.guardChanges]
        .filter((change) => change.at <= at)
        .sort((a, b) => a.at - b.at || a.sequence - b.sequence)
        .at(-1)?.subscribed ?? true
    );
  }

  private applyChangesThrough(at: number): void {
    for (const event of this.journalEvents
      .filter((item) => new Date(item.occurredAt).getTime() <= at)
      .sort(
        (left, right) =>
          new Date(left.occurredAt).getTime() -
            new Date(right.occurredAt).getTime() ||
          left.sequence - right.sequence,
      )) {
      this.reportEvent(event);
    }
    for (const change of this.guardChanges
      .filter((item) => !item.reported && item.at <= at)
      .sort((a, b) => a.at - b.at || a.sequence - b.sequence)) {
      change.reported = true;
      this.recordTimeline({
        type: "guard",
        at: new Date(change.at).toISOString(),
        subscribed: change.subscribed,
      });
    }
  }

  private conditionsMatch(
    event: TestEvent,
    where: ReturnType<typeof normalizeWhere>,
  ): boolean {
    return (
      !where?.length ||
      evaluatePropertyConditions({
        conditions: where,
        properties: event.properties,
      })
    );
  }

  private exitEventBefore(targetMs: number): TestEvent | undefined {
    return [...this.journalEvents]
      .filter((event) => {
        const at = new Date(event.occurredAt).getTime();
        if (
          at <= this.currentMs ||
          at > targetMs ||
          event.userId !== this.options.user.id
        )
          return false;
        return this.matchesExitEvent(event);
      })
      .sort(
        (a, b) =>
          new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime() ||
          a.sequence - b.sequence,
      )[0];
  }

  private matchesExitEvent(event: TestEvent): boolean {
    return (this.journey.meta.exitOn ?? []).some(
      (exit) =>
        exit.event === event.event && this.conditionsMatch(event, exit.where),
    );
  }

  private captureExitOn(event: TestEvent): never {
    const captured = {
      at: this.now.toISOString(),
      source: "exitOn" as const,
      reason: event.event,
    };
    this.updateCurrentJourney("exited");
    this.effects.exits.push(captured);
    this.recordTimeline({ type: "exit", ...captured });
    throw new JourneyExitedError(STATE_ID);
  }

  private advanceTo(targetMs: number): void {
    const target = Math.max(this.currentMs, targetMs);
    if (this.pendingExitEvent) {
      const pending = this.pendingExitEvent;
      this.pendingExitEvent = undefined;
      this.applyChangesThrough(this.currentMs);
      this.captureExitOn(pending);
    }
    const exit = this.exitEventBefore(target);
    const end = exit ? new Date(exit.occurredAt).getTime() : target;
    this.applyChangesThrough(end);
    this.currentMs = end;
    if (exit) this.captureExitOn(exit);
  }

  private hasRecentJourneySend(
    channel: "email" | "sms",
    recipient: string,
  ): boolean {
    const suppressMs = durationToMs(this.journey.meta.suppress ?? {});
    if (suppressMs <= 0) return false;
    const since = this.currentMs - suppressMs;
    const history = channel === "email" ? this.emailHistory : this.smsHistory;
    return history.some((item) => {
      const at = new Date(item.sentAt).getTime();
      const to = "email" in item ? item.email : item.phone;
      return (
        item.journeyId === this.journey.meta.id &&
        to === recipient &&
        at >= since &&
        at <= this.currentMs
      );
    });
  }

  private isCategorySubscribed(category: string): boolean {
    return isListSubscribed({
      categories: this.recipientPreferences.categories ?? {},
      id: category,
      defaultOptIn: this.recipientPreferences.defaultOptIn?.[category] ?? true,
    });
  }

  private setLabel(label: string): void {
    this.currentLabel = label;
    const boundary = getJourneyBoundary();
    if (boundary) boundary.currentLabel = label;
  }

  private createServices(): JourneyServiceOverrides {
    return {
      email: async (effect) => {
        if (effect.idempotencyKey) {
          const prior = this.emailIdempotency.get(effect.idempotencyKey);
          if (prior)
            return this.jsonSnapshot(prior, "email idempotency result");
        }
        const definition = this.options.templates
          ? (getTemplateDefinition({
              key: effect.template as never,
              registry: this.options.templates,
            }) as { defaultSubject: string })
          : undefined;
        if (this.recipientPreferences.suppressed) {
          const at = this.now.toISOString();
          const result = {
            emailSendId: `test-email-suppressed-${++this.serviceAttemptSequence}`,
            sentAt: at,
          };
          this.recordTimeline({
            type: "email",
            at,
            template: effect.template,
            to: effect.to,
            status: "suppressed",
            reason: "suppressed",
          });
          return result;
        }
        if (!this.subscriptionAt(this.currentMs)) {
          const at = this.now.toISOString();
          const result = {
            emailSendId: `test-email-unsubscribed-${++this.serviceAttemptSequence}`,
            sentAt: at,
          };
          this.recordTimeline({
            type: "email",
            at,
            template: effect.template,
            to: effect.to,
            status: "unsubscribed",
          });
          return result;
        }
        if (!this.isCategorySubscribed(effect.category)) {
          const at = this.now.toISOString();
          const result = {
            emailSendId: `test-email-unsubscribed-${++this.serviceAttemptSequence}`,
            sentAt: at,
          };
          this.recordTimeline({
            type: "email",
            at,
            template: effect.template,
            to: effect.to,
            status: "unsubscribed",
            reason: "category_unsubscribed",
          });
          return result;
        }
        if (this.hasRecentJourneySend("email", effect.to)) {
          const at = this.now.toISOString();
          const result = {
            emailSendId: "",
            sentAt: at,
          };
          this.recordTimeline({
            type: "email",
            at,
            template: effect.template,
            to: effect.to,
            status: "skipped",
            reason: "journey_suppressed",
          });
          return result;
        }
        const message: MailboxMessage = {
          channel: "email",
          to: effect.to,
          template: effect.template,
          subject: effect.subject ?? definition?.defaultSubject,
          props: this.jsonSnapshot(effect.props, "email props"),
          sentAt: this.now.toISOString(),
          category: effect.category,
          resultId: `test-email-${this.effects.emails.length + 1}`,
        };
        this.mailbox.messages.push(message);
        this.effects.emails.push(
          this.jsonSnapshot(message, "captured email effect"),
        );
        this.emailHistory.push({
          email: message.to,
          template: message.template,
          sentAt: message.sentAt,
          category: message.category,
          journeyId: this.journey.meta.id,
        });
        this.recordTimeline({ type: "email", at: message.sentAt, ...message });
        const result = {
          emailSendId: message.resultId,
          sentAt: message.sentAt,
        };
        if (effect.idempotencyKey) {
          this.emailIdempotency.set(
            effect.idempotencyKey,
            this.jsonSnapshot(result, "email idempotency result"),
          );
        }
        return this.jsonSnapshot(result, "email send result");
      },
      sms: async (effect) => {
        if (effect.idempotencyKey) {
          const prior = this.smsIdempotency.get(effect.idempotencyKey);
          if (prior) return this.jsonSnapshot(prior, "SMS idempotency result");
        }
        if (this.options.smsTemplates) {
          getSmsTemplateDefinition({
            key: effect.template as never,
            registry: this.options.smsTemplates,
          });
        }
        const consent = this.options.smsConsent ?? "missing";
        if (consent === "suppressed") {
          const at = this.now.toISOString();
          const result = {
            smsSendId: `test-sms-suppressed-${++this.serviceAttemptSequence}`,
            status: "suppressed" as const,
          };
          this.recordTimeline({
            type: "sms",
            at,
            template: effect.template,
            to: effect.to,
            status: result.status,
            reason: "phone_suppressed",
          });
          return result;
        }
        if (!this.subscriptionAt(this.currentMs)) {
          const at = this.now.toISOString();
          const result = {
            smsSendId: `test-sms-unsubscribed-${++this.serviceAttemptSequence}`,
            status: "unsubscribed" as const,
          };
          this.recordTimeline({
            type: "sms",
            at,
            template: effect.template,
            to: effect.to,
            status: "unsubscribed",
          });
          return result;
        }
        const preferenceExempt = effect.category === "transactional";
        const smsChannel = this.recipientPreferences.categories?.sms;
        const consentGranted = consent === "granted" || smsChannel === true;
        if (
          !preferenceExempt &&
          (consent === "opted_out" || smsChannel === false || !consentGranted)
        ) {
          const at = this.now.toISOString();
          const status =
            consent === "opted_out" || smsChannel === false
              ? ("unsubscribed" as const)
              : ("no_consent" as const);
          const result = {
            smsSendId: `test-sms-${status}-${++this.serviceAttemptSequence}`,
            status,
          };
          this.recordTimeline({
            type: "sms",
            at,
            template: effect.template,
            to: effect.to,
            status,
            reason:
              consent === "opted_out" || smsChannel === false
                ? "channel_off"
                : "no_consent",
          });
          return result;
        }
        if (!preferenceExempt && !this.isCategorySubscribed(effect.category)) {
          const at = this.now.toISOString();
          const result = {
            smsSendId: `test-sms-unsubscribed-${++this.serviceAttemptSequence}`,
            status: "unsubscribed" as const,
          };
          this.recordTimeline({
            type: "sms",
            at,
            template: effect.template,
            to: effect.to,
            status: result.status,
            reason: "category_unsubscribed",
          });
          return result;
        }
        if (this.hasRecentJourneySend("sms", effect.to)) {
          const at = this.now.toISOString();
          const result = {
            smsSendId: "",
            status: "skipped" as const,
            reason: "journey_suppressed",
          };
          this.recordTimeline({
            type: "sms",
            at,
            template: effect.template,
            to: effect.to,
            status: result.status,
            reason: result.reason,
          });
          return result;
        }
        const message: MailboxMessage = {
          channel: "sms",
          to: effect.to,
          template: effect.template,
          props: this.jsonSnapshot(effect.props, "SMS props"),
          sentAt: this.now.toISOString(),
          category: effect.category,
          resultId: `test-sms-${this.effects.sms.length + 1}`,
        };
        this.mailbox.messages.push(message);
        this.effects.sms.push(
          this.jsonSnapshot(message, "captured SMS effect"),
        );
        this.smsHistory.push({
          phone: message.to,
          template: message.template,
          sentAt: message.sentAt,
          journeyId: this.journey.meta.id,
        });
        this.recordTimeline({ type: "sms", at: message.sentAt, ...message });
        const result = {
          smsSendId: message.resultId,
          status: "sent" as const,
          sentAt: message.sentAt,
        };
        if (effect.idempotencyKey) {
          this.smsIdempotency.set(
            effect.idempotencyKey,
            this.jsonSnapshot(result, "SMS idempotency result"),
          );
        }
        return this.jsonSnapshot(result, "SMS send result");
      },
      connectorActionExists: (connectorId, action) =>
        this.options.connectorActions?.some(
          (candidate) =>
            candidate.connectorId === connectorId && candidate.name === action,
        ) ?? false,
      connector: async (effect) => {
        const definition = this.options.connectorActions?.find(
          (candidate) =>
            candidate.connectorId === effect.connectorId &&
            candidate.name === effect.action,
        );
        // `sendConnectorAction` validates through connectorActionExists before
        // invoking this callback. Retain a defensive assertion for direct
        // boundary use and future helper refactors.
        if (!definition) {
          throw new Error(
            `no connector action "${effect.connectorId}:${effect.action}" is registered ` +
              "(pass it via createJourneyTest({ connectorActions }))",
          );
        }
        if (
          definition.audience?.kind === "member" &&
          !this.subscriptionAt(this.currentMs)
        ) {
          const at = this.now.toISOString();
          this.recordTimeline({
            type: "connector",
            at,
            connectorId: effect.connectorId,
            action: effect.action,
            status: "skipped",
            reason: "unsubscribed_all",
          });
          return {
            skipped: true,
            reason: "unsubscribed_all",
            connectorId: effect.connectorId,
            action: effect.action,
          };
        }
        if (
          definition.audience?.kind === "member" &&
          !this.isCategorySubscribed(effect.connectorId)
        ) {
          const at = this.now.toISOString();
          this.recordTimeline({
            type: "connector",
            at,
            connectorId: effect.connectorId,
            action: effect.action,
            status: "skipped",
            reason: "channel_unsubscribed",
          });
          return {
            skipped: true,
            reason: "channel_unsubscribed",
            connectorId: effect.connectorId,
            action: effect.action,
          };
        }
        const record = {
          ...this.jsonSnapshot(effect, "connector action"),
          at: this.now.toISOString(),
          resultId: `test-connector-${this.effects.connectors.length + 1}`,
        };
        this.effects.connectors.push(record);
        this.recordTimeline({ type: "connector", ...record });
        const configured = definition.result;
        return typeof configured === "function"
          ? configured(effect.args)
          : (configured ?? { id: record.resultId });
      },
      feed: async (effect) => {
        const recipientKey =
          effect.recipient.userId ??
          effect.recipient.email ??
          effect.recipient.anonymousId ??
          null;
        const hasPreferenceSurface = Boolean(
          effect.recipient.userId || effect.recipient.email,
        );
        if (hasPreferenceSurface && !this.subscriptionAt(this.currentMs)) {
          const at = this.now.toISOString();
          this.recordTimeline({
            type: "feed",
            at,
            feedType: effect.type,
            recipientKey,
            status: "suppressed",
            reason: "unsubscribed_all",
          });
          return {
            feedItemId: null,
            recipientKey,
            suppressed: true,
            createdAt: null,
          };
        }
        if (hasPreferenceSurface && !this.isCategorySubscribed("in_app")) {
          const at = this.now.toISOString();
          this.recordTimeline({
            type: "feed",
            at,
            feedType: effect.type,
            recipientKey,
            status: "suppressed",
            reason: "channel_unsubscribed",
          });
          return {
            feedItemId: null,
            recipientKey,
            suppressed: true,
            createdAt: null,
          };
        }
        if (
          effect.idempotencyKey &&
          this.feedIdempotency.has(effect.idempotencyKey)
        ) {
          return {
            feedItemId: null,
            recipientKey,
            suppressed: false,
            createdAt: null,
          };
        }
        const record = {
          ...this.jsonSnapshot(effect, "feed item"),
          at: this.now.toISOString(),
          resultId: `test-feed-${this.effects.feed.length + 1}`,
        };
        this.effects.feed.push(record);
        const { type: feedType, ...timelineRecord } = record;
        this.recordTimeline({ type: "feed", feedType, ...timelineRecord });
        if (effect.idempotencyKey)
          this.feedIdempotency.set(effect.idempotencyKey, record.resultId);
        return {
          feedItemId: record.resultId,
          recipientKey,
          suppressed: false,
          createdAt: record.at,
        };
      },
    };
  }

  private matchingEvents(opts: {
    event?: string;
    userId: string;
    since?: number;
    through?: number;
    where?: ReturnType<typeof normalizeWhere>;
  }): TestEvent[] {
    return this.journalEvents.filter((event) => {
      const at = new Date(event.occurredAt).getTime();
      return (
        event.userId === opts.userId &&
        (!opts.event || event.event === opts.event) &&
        (opts.since === undefined || at >= opts.since) &&
        (opts.through === undefined || at <= opts.through) &&
        this.conditionsMatch(event, opts.where)
      );
    });
  }

  private createContext(): JourneyContext {
    return {
      when: createWhenBuilder({
        timezone: this.options.timezone ?? "UTC",
        window: this.options.sendWindow,
        now: () => this.now,
      }),
      sleep: async ({ duration, label }) => {
        const started = this.now.toISOString();
        const node = label ?? `wait:${JSON.stringify(duration)}`;
        this.setLabel(node);
        this.advanceWait({
          type: "sleep",
          at: started,
          label: node,
          targetMs: this.currentMs + durationToMs(duration),
          outcome: "resumed",
        });
        return { sleptAt: started, resumedAt: this.now.toISOString() };
      },
      sleepUntil: async (at, opts) => {
        const started = this.now.toISOString();
        const target = toDate(at, "sleepUntil");
        const node = opts?.label ?? `wait-until:${target.toISOString()}`;
        this.setLabel(node);
        this.advanceWait({
          type: "sleepUntil",
          at: started,
          label: node,
          targetMs: target.getTime(),
          outcome: "resumed",
        });
        return { sleptAt: started, resumedAt: this.now.toISOString() };
      },
      waitForEvent: async ({ event, timeout, label, lookback, where }) => {
        const timeoutMs = durationToMs(timeout);
        if (timeoutMs > MAX_WAIT_MS) {
          throw new RangeError(
            "waitForEvent timeout exceeds the journey execution limit (720h)",
          );
        }
        const startedMs = this.currentMs;
        const node = label ?? `wait-event:${event}`;
        this.setLabel(node);
        if (this.pendingExitEvent) {
          this.updateCurrentJourney("waiting");
          try {
            this.advanceTo(startedMs);
          } catch (error) {
            if (error instanceof JourneyExitedError) {
              this.captureWait(
                "waitForEvent",
                new Date(startedMs).toISOString(),
                node,
                "exited",
                { event, source: "pending" },
              );
            }
            throw error;
          }
        }
        const normalized = normalizeWhere(where);
        if (lookback) {
          const hit = this.matchingEvents({
            event,
            userId: this.options.user.id,
            since: startedMs - durationToMs(lookback),
            through: startedMs,
            where: normalized,
          }).sort(
            (a, b) =>
              new Date(b.occurredAt).getTime() -
                new Date(a.occurredAt).getTime() || b.sequence - a.sequence,
          )[0];
          if (hit) {
            this.captureWait(
              "waitForEvent",
              new Date(startedMs).toISOString(),
              node,
              "matched",
              { event, timedOut: false, source: "lookback" },
            );
            return {
              timedOut: false,
              properties: scalars(hit.properties),
              ...(normalized?.length ? {} : { occurredAt: hit.occurredAt }),
            };
          }
        }
        const deadline = startedMs + timeoutMs;
        const hit = this.matchingEvents({
          event,
          userId: this.options.user.id,
          since: startedMs + 1,
          through: deadline,
          where: normalized,
        }).sort(
          (a, b) =>
            new Date(a.occurredAt).getTime() -
              new Date(b.occurredAt).getTime() || a.sequence - b.sequence,
        )[0];
        this.advanceWait({
          type: "waitForEvent",
          at: new Date(startedMs).toISOString(),
          label: node,
          targetMs: hit ? new Date(hit.occurredAt).getTime() : deadline,
          outcome: hit ? "matched" : "timedOut",
          detail: { event, timedOut: !hit, source: "forward" },
        });
        return hit
          ? { timedOut: false, properties: scalars(hit.properties) }
          : { timedOut: true };
      },
      checkpoint: async (label) => {
        this.setLabel(label);
        const item = { label, at: this.now.toISOString() };
        this.effects.checkpoints.push(item);
        this.recordTimeline({ type: "checkpoint", ...item });
      },
      trigger: async (opts: TriggerOptions) => {
        const boundary = getJourneyBoundary();
        if (boundary) {
          const site =
            opts.idempotencyLabel ?? boundary.currentLabel ?? opts.event;
          registerKey(
            boundary,
            deriveJourneyKey({
              kind: "trigger",
              anchor: boundary.runAnchor,
              site,
              discriminant: opts.event,
            }),
          );
        }
        const userEmail = opts.userEmail ?? this.options.user.email;
        const trigger: CapturedTrigger = {
          event: opts.event,
          userId: opts.userId,
          ...(userEmail ? { userEmail } : {}),
          properties: this.jsonSnapshot(
            opts.properties ?? {},
            "trigger properties",
          ),
          ...(opts.value !== undefined ? { value: opts.value } : {}),
          ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
          triggeredAt: this.now.toISOString(),
        };
        this.effects.triggers.push(trigger);
        this.addEvent(
          this.currentMs,
          opts.event,
          opts.properties,
          { userId: opts.userId, userEmail },
          "trigger",
        );
        this.recordTimeline({
          type: "trigger",
          at: trigger.triggeredAt,
          ...trigger,
        });
        await this.options.onTrigger?.(
          this.jsonSnapshot(trigger, "captured trigger callback"),
        );
      },
      exit: async (reason): Promise<never> => {
        const item = {
          ...(reason ? { reason } : {}),
          at: this.now.toISOString(),
          source: "manual" as const,
        };
        this.updateCurrentJourney("exited");
        this.effects.exits.push(item);
        this.recordTimeline({ type: "exit", ...item });
        throw new JourneyExitedError(STATE_ID);
      },
      now: async () => this.now,
      once: async <T>(key: string, compute: () => Promise<T> | T): Promise<T> =>
        this.recordOnce("__once__", key, compute),
      variant: async <const A extends readonly [string, ...string[]]>(
        key: string,
        arms: A,
      ): Promise<A[number]> => {
        // Mirrors the engine's validate-vs-never-throw split: key syntax
        // gates the record path; arms validation runs only in compute, so a
        // seeded (recorded) assignment is returned verbatim — including an
        // arm outside the current array (silently; see JourneyTestOptions
        // .variants).
        validateVariantKey(key);
        const assigned = await this.recordOnce("__variants__", key, () => {
          validateVariantArms(arms);
          return pickVariant({
            journeyId: this.journey.meta.id,
            key,
            userId: this.options.user.id,
            arms,
          });
        });
        return assigned as A[number];
      },
      digest: async (opts: DigestOptions) => {
        const event = opts.event ?? this.journey.meta.trigger.event;
        const windowMs = durationToMs(opts.window);
        if (windowMs <= 0)
          throw new RangeError("ctx.digest window must be a positive duration");
        if (windowMs > MAX_WAIT_MS) {
          throw new RangeError(
            "ctx.digest window exceeds the journey execution limit (720h)",
          );
        }
        const start = this.currentMs;
        const label = opts.label ?? `digest:${event}`;
        registerRecordLabel(getJourneyBoundary(), label);
        this.setLabel(label);
        const deadline = await this.recordOnce(
          "__digest__",
          `${label}:deadline`,
          () => new Date(start + windowMs).toISOString(),
        );
        this.advanceWait({
          type: "digest",
          at: new Date(start).toISOString(),
          label,
          targetMs: new Date(deadline).getTime(),
          outcome: "resumed",
          detail: { event },
        });
        const where = normalizeWhere(
          opts.where ??
            (event === this.journey.meta.trigger.event
              ? this.journey.meta.trigger.where
              : undefined),
        );
        const cap = Math.min(500, Math.max(1, opts.maxEvents ?? 100));
        const all = this.matchingEvents({
          event,
          userId: this.options.user.id,
          since: start - durationToMs(opts.lookback ?? { minutes: 15 }),
          through: this.currentMs,
          where,
        }).sort(
          (a, b) =>
            new Date(a.occurredAt).getTime() -
              new Date(b.occurredAt).getTime() || a.sequence - b.sequence,
        );
        const picked = all.slice(0, cap);
        return this.recordOnce("__digest__", `${label}:result`, () => ({
          events: picked.map((item) => ({
            properties: scalars(item.properties),
            occurredAt: item.occurredAt,
          })),
          count: picked.length,
          truncated: all.length > cap,
          flushedAt: this.now.toISOString(),
        }));
      },
      throttle: async (opts: ThrottleOptions) => {
        if (!Number.isInteger(opts.limit) || opts.limit < 1)
          throw new RangeError("ctx.throttle limit must be an integer >= 1");
        const windowMs = durationToMs(opts.window);
        if (windowMs <= 0)
          throw new RangeError(
            "ctx.throttle window must be a positive duration",
          );
        const key = `${opts.label ?? this.currentLabel ?? "start"}:${opts.category ?? "*"}:${opts.limit}/${windowMs}`;
        registerRecordLabel(getJourneyBoundary(), `throttle:${key}`);
        return this.recordOnce("__throttle__", key, () => {
          const since = this.currentMs - windowMs;
          const count = this.emailHistory.filter(
            (item) =>
              item.email === this.options.user.email &&
              new Date(item.sentAt).getTime() >= since &&
              new Date(item.sentAt).getTime() <= this.currentMs &&
              (!opts.category || item.category === opts.category),
          ).length;
          return {
            allowed: count < opts.limit,
            count,
            remaining: Math.max(0, opts.limit - count),
          };
        });
      },
      guard: { isSubscribed: async () => this.subscriptionAt(this.currentMs) },
      history: {
        hasEvent: async ({ userId, event, within }) => {
          const matches = this.matchingEvents({
            event,
            userId,
            through: this.currentMs,
            ...(within ? { since: this.currentMs - durationToMs(within) } : {}),
          });
          return { found: matches.length > 0, count: matches.length };
        },
        journey: async ({ userId, journeyId }) => {
          const matches = this.journeyHistory.filter(
            (item) =>
              item.userId === userId &&
              item.journeyId === journeyId &&
              new Date(item.enteredAt ?? item.completedAt ?? 0).getTime() <=
                this.currentMs,
          );
          const completed = matches
            .filter(
              (item) =>
                item.completedAt !== undefined &&
                new Date(item.completedAt).getTime() <= this.currentMs,
            )
            .sort(
              (a, b) =>
                new Date(b.completedAt as string).getTime() -
                new Date(a.completedAt as string).getTime(),
            );
          return {
            completed: completed.length > 0,
            lastCompletedAt: completed[0]?.completedAt ?? null,
            entryCount: matches.length,
          };
        },
        email: async ({ email, template }) => {
          const matches = this.emailHistory
            .filter(
              (item) => item.email === email && item.template === template,
            )
            .filter((item) => new Date(item.sentAt).getTime() <= this.currentMs)
            .sort(
              (a, b) =>
                new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(),
            );
          return {
            sent: matches.length > 0,
            lastSentAt: matches[0]?.sentAt ?? null,
            count: matches.length,
          };
        },
        sms: async ({ phone, template }) => {
          const matches = this.smsHistory
            .filter(
              (item) => item.phone === phone && item.template === template,
            )
            .filter((item) => new Date(item.sentAt).getTime() <= this.currentMs)
            .sort(
              (a, b) =>
                new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(),
            );
          return {
            sent: matches.length > 0,
            lastSentAt: matches[0]?.sentAt ?? null,
            count: matches.length,
          };
        },
        events: async ({ userId, event, limit = 50, within }) =>
          this.matchingEvents({
            userId,
            event,
            through: this.currentMs,
            ...(within ? { since: this.currentMs - durationToMs(within) } : {}),
          })
            .sort(
              (a, b) =>
                new Date(b.occurredAt).getTime() -
                  new Date(a.occurredAt).getTime() || b.sequence - a.sequence,
            )
            .slice(0, limit)
            .map(
              (item): RecentEvent => ({
                event: item.event,
                properties: this.jsonSnapshot(
                  item.properties,
                  "event history properties",
                ),
                occurredAt: item.occurredAt,
              }),
            ),
      },
    };
  }

  private computedEntry(): { allowed: boolean; reason?: string } {
    if (this.journey.meta.entryLimit === "unlimited") return { allowed: true };
    const prior = this.journeyHistory.filter(
      (item) =>
        item.userId === this.options.user.id &&
        item.journeyId === this.journey.meta.id &&
        new Date(item.enteredAt ?? item.completedAt ?? 0).getTime() <=
          this.currentMs,
    );
    if (this.journey.meta.entryLimit === "once")
      return prior.length
        ? { allowed: false, reason: "already_entered_once" }
        : { allowed: true };
    const cutoff =
      this.currentMs - durationToMs(this.journey.meta.entryPeriod ?? hours(24));
    const recent = prior.some(
      (item) =>
        new Date(item.enteredAt ?? item.completedAt ?? 0).getTime() > cutoff,
    );
    return recent
      ? { allowed: false, reason: "period_not_elapsed" }
      : { allowed: true };
  }

  private checkEntry(
    fixtures: EntryFixtures = {},
  ): ReturnType<typeof evaluateEnrollmentPolicy> {
    const configured = { ...this.options.entry, ...fixtures };
    const heldOut =
      configured.heldOut ??
      (this.journey.meta.holdout?.percent
        ? isHeldOut({
            userId: this.options.user.id,
            journeyId: this.journey.meta.id,
            percent: this.journey.meta.holdout.percent,
            salt: this.journey.meta.holdout.salt,
          })
        : false);
    return evaluateEnrollmentPolicy({
      journey: this.journey.meta,
      properties: this.options.user.properties,
      facts: {
        ...configured,
        entry: configured.entry ?? this.computedEntry(),
        unsubscribed:
          configured.unsubscribed ?? !this.subscriptionAt(this.currentMs),
        heldOut,
        alreadyActive:
          configured.alreadyActive ??
          this.journeyHistory.some(
            (item) =>
              item.userId === this.options.user.id &&
              item.journeyId === this.journey.meta.id &&
              new Date(item.enteredAt ?? item.completedAt ?? 0).getTime() <=
                this.currentMs &&
              ["active", "waiting"].includes(item.status ?? ""),
          ),
      },
    });
  }

  async run(): Promise<"completed" | "exited"> {
    if (this.hasRun)
      throw new Error(
        "createJourneyTest: run() may only be called once; create a new harness for another run",
      );
    this.hasRun = true;
    this.currentJourney = {
      userId: this.options.user.id,
      journeyId: this.journey.meta.id,
      enteredAt: this.now.toISOString(),
      status: "active",
    };
    this.journeyHistory.push(this.currentJourney);
    this.addEvent(
      this.currentMs,
      this.journey.meta.trigger.event,
      this.options.user.properties,
      {},
      "enrollment",
    );
    this.applyChangesThrough(this.currentMs);
    const user: JourneyUser = {
      ...this.options.user,
      properties: this.jsonSnapshot(
        this.options.user.properties,
        "journey user properties",
      ),
      stateId: STATE_ID,
      journeyId: this.journey.meta.id,
      journeyName: this.journey.meta.name,
    };
    const boundary: JourneyBoundary = {
      stateId: STATE_ID,
      runAnchor: RUN_ID,
      currentLabel: undefined,
      seenKeys: new Set(),
      seenRecordLabels: new Set(),
      memoize: async (_deps, fn) => fn(),
      journeyId: this.journey.meta.id,
      suppressMs: durationToMs(this.journey.meta.suppress ?? {}),
      category: this.journey.meta.category,
      now: () => this.now,
      services: this.createServices(),
    };
    try {
      await runWithJourneyBoundary(boundary, () =>
        this.journey.run(user, this.context),
      );
      this.updateCurrentJourney("completed");
      return "completed";
    } catch (error) {
      if (error instanceof JourneyExitedError) {
        this.updateCurrentJourney("exited");
        return "exited";
      }
      this.updateCurrentJourney("failed");
      throw error;
    }
  }
}

export function createJourneyTest(
  journey: JourneyDefinition,
  options: JourneyTestOptions,
): JourneyTest {
  return new JourneyTest(journey, options);
}
