import type { DurationObject } from "@hogsend/core";
import type { JourneyMeta } from "@hogsend/core/types";
import type { TemplateRegistry } from "@hogsend/email";
import type {
  EnrollmentPolicyFacts,
  EnrollmentPolicyResult,
} from "@hogsend/engine/testing";
import type { SmsTemplateRegistry } from "@hogsend/sms";

export interface TestJourneyUser {
  id: string;
  email: string;
  properties: Record<string, string | number | boolean | null>;
}

export interface EventTarget {
  userId?: string;
  userEmail?: string;
  /** groupType→groupKey association the scripted event carries (mirrors
   * `user_events.groups`); matched by group-scoped waits/hasEvent. */
  groups?: Record<string, string>;
}

export interface TestEvent {
  event: string;
  properties: Record<string, unknown>;
  userId: string;
  userEmail?: string;
  groups?: Record<string, string>;
  occurredAt: string;
  source: "enrollment" | "script" | "trigger";
  sequence: number;
}

export interface TestEmailHistory {
  email: string;
  template: string;
  sentAt: string;
  category?: string;
  /** Journey owning the send; required for cross-enrollment meta.suppress. */
  journeyId?: string;
}

export interface TestSmsHistory {
  phone: string;
  template: string;
  sentAt: string;
  /** Journey owning the send; required for cross-enrollment meta.suppress. */
  journeyId?: string;
}

/** Explicit SMS permission state used by the production-equivalent send gate. */
export type TestSmsConsent = "granted" | "missing" | "opted_out" | "suppressed";

/** Static recipient preference facts consulted by captured outbound services. */
export interface TestRecipientPreferences {
  /** Email transport suppression, such as a hard bounce or complaint. */
  suppressed?: boolean;
  /** Explicit topic/channel membership overrides; `false` blocks delivery. */
  categories?: Record<string, boolean>;
  /** Per-list default polarity; `false` requires an explicit `true` grant. */
  defaultOptIn?: Record<string, boolean>;
}

export interface TestJourneyHistory {
  userId: string;
  journeyId: string;
  completedAt?: string;
  enteredAt?: string;
  status?: "active" | "waiting" | "completed" | "exited" | "failed";
}

export interface JourneyHistoryFixtures {
  events?: Array<
    Omit<TestEvent, "sequence" | "source"> & { source?: TestEvent["source"] }
  >;
  emails?: TestEmailHistory[];
  sms?: TestSmsHistory[];
  journeys?: TestJourneyHistory[];
}

export interface EntryFixtures extends EnrollmentPolicyFacts {
  /** Explicitly replaces the entry-limit verdict computed from history. */
  entry?: { allowed: boolean; reason?: string };
}

/**
 * Connector metadata needed to validate and deterministically capture an
 * action without running the plugin or touching its database-backed audience
 * resolver. A real `DefinedConnectorAction` is structurally assignable to this
 * shape; `result` can be supplied by tests that branch on the action response.
 */
export interface TestConnectorAction {
  connectorId: string;
  name: string;
  audience?: { kind: "member" };
  result?:
    | null
    | string
    | number
    | boolean
    | Record<string, unknown>
    | readonly unknown[]
    | ((args: unknown) => unknown | Promise<unknown>);
}

export interface JourneyTestOptions {
  user: TestJourneyUser;
  now?: Date | string;
  timezone?: string;
  sendWindow?: { start: string; end: string };
  templates?: TemplateRegistry;
  /** Optional SMS registry used for the same runtime key validation as production. */
  smsTemplates?: SmsTemplateRegistry;
  /** Defaults to `missing`, matching production's explicit opt-in policy. */
  smsConsent?: TestSmsConsent;
  /** Recipient preference facts shared by email, SMS, feed, and connectors. */
  preferences?: TestRecipientPreferences;
  history?: JourneyHistoryFixtures;
  entry?: EntryFixtures;
  /**
   * groupType→groupKey association carried by the synthesized enrollment
   * (trigger) event — the ONLY source a bare-string `group:` option resolves
   * from in the harness (no membership database exists here; engine leg 2).
   */
  triggerGroups?: Record<string, string>;
  /**
   * Global master subscription state. Scheduled changes also gate captured
   * recipient-directed effects after virtual time crosses their timestamp.
   */
  subscribed?: boolean;
  once?: Record<string, unknown>;
  /**
   * Seed recorded `ctx.variant` assignments (the `__variants__` bag), keyed
   * by variant key. A seeded arm wins VERBATIM — even when it is not in the
   * journey's current `arms` array it is returned silently (mirroring the
   * engine's recorded-wins-across-deploys semantics; the engine's warn-once
   * advisory is a production log, not a harness effect).
   */
  variants?: Record<string, string>;
  /** Registered connector actions available to this isolated harness. */
  connectorActions?: readonly TestConnectorAction[];
  onTrigger?: (trigger: CapturedTrigger) => void | Promise<void>;
}

export interface MailboxMessage {
  channel: "email" | "sms";
  to: string;
  template: string;
  subject?: string;
  props: Record<string, unknown>;
  sentAt: string;
  category: string;
  resultId: string;
}

export interface RenderedTestEmail {
  html: string;
  text: string;
  subject: string;
  message: MailboxMessage;
}

export interface CapturedTrigger {
  event: string;
  userId: string;
  userEmail?: string;
  properties: Record<string, unknown>;
  value?: number;
  currency?: string;
  triggeredAt: string;
}

export interface CapturedCheckpoint {
  label: string;
  at: string;
}
export interface CapturedExit {
  reason?: string;
  at: string;
  source: "manual" | "exitOn";
}

/**
 * One chronological harness record. Wait entries (`sleep`, `sleepUntil`,
 * `waitForEvent`, `digest`) carry `label`, `outcome`, `resumedAt` and
 * `durationMs` (the planned length: sleep duration, time until a `sleepUntil`
 * target, `waitForEvent` timeout, digest window). Recipient-directed entries
 * (`email`, `sms`, `feed`, `connector`) carry `idempotencyLabel` when the call
 * passed an explicit one. `variant` entries carry `key` and `arm`.
 */
export interface TimelineEntry {
  type:
    | "event"
    | "sleep"
    | "sleepUntil"
    | "waitForEvent"
    | "digest"
    | "checkpoint"
    | "exit"
    | "email"
    | "sms"
    | "connector"
    | "feed"
    | "trigger"
    | "guard"
    | "variant";
  at: string;
  [key: string]: unknown;
}

export interface JourneyEffects {
  emails: MailboxMessage[];
  sms: MailboxMessage[];
  connectors: Array<Record<string, unknown>>;
  feed: Array<Record<string, unknown>>;
  triggers: CapturedTrigger[];
  waits: TimelineEntry[];
  checkpoints: CapturedCheckpoint[];
  exits: CapturedExit[];
}

export interface EventsController {
  emit(
    event: string,
    properties?: Record<string, unknown>,
    target?: EventTarget,
  ): TestEvent;
  after(
    duration: DurationObject,
    event: string,
    properties?: Record<string, unknown>,
    target?: EventTarget,
  ): TestEvent;
  at(
    instant: Date | string,
    event: string,
    properties?: Record<string, unknown>,
    target?: EventTarget,
  ): TestEvent;
}

export interface GuardController {
  isSubscribed(): boolean;
  setSubscribed(subscribed: boolean): void;
  after(duration: DurationObject, subscribed: boolean): void;
  at(instant: Date | string, subscribed: boolean): void;
}

export interface HistoryController {
  addJourney(fixture: TestJourneyHistory): void;
  addEmail(
    fixture: Omit<TestEmailHistory, "sentAt"> & { sentAt?: Date | string },
  ): void;
  addSms(
    fixture: Omit<TestSmsHistory, "sentAt"> & { sentAt?: Date | string },
  ): void;
}

export interface OnceController {
  set(key: string, value: unknown): void;
  has(key: string): boolean;
}

export interface EntryController {
  check(fixtures?: EntryFixtures): EnrollmentPolicyResult;
}

export interface ScenarioEvent {
  event: string;
  properties?: Record<string, unknown>;
  after?: DurationObject;
  at?: Date | string;
  userId?: string;
  userEmail?: string;
}

/** A scheduled change to the global subscription guard. */
export interface ScenarioGuardChange {
  subscribed: boolean;
  after?: DurationObject;
  at?: Date | string;
}

export interface JourneyScenario {
  name: string;
  user: TestJourneyUser;
  now?: Date | string;
  timezone?: string;
  templates?: TemplateRegistry;
  smsTemplates?: SmsTemplateRegistry;
  smsConsent?: TestSmsConsent;
  preferences?: TestRecipientPreferences;
  connectorActions?: readonly TestConnectorAction[];
  events?: ScenarioEvent[];
  /** Initial global subscription state (default `true`). */
  subscribed?: boolean;
  /** Scheduled subscription changes, e.g. an unsubscribe on day 3. */
  guard?: ScenarioGuardChange[];
  /** Prior events, sends and enrollments visible to `ctx.history`. */
  history?: JourneyHistoryFixtures;
  /** Enrollment-policy facts for `entry.check()` (holdout, admin override). */
  entry?: EntryFixtures;
  /** Recorded `ctx.variant` arms, keyed by variant key. */
  variants?: Record<string, string>;
  setup?: (test: import("./harness.js").JourneyTest) => void | Promise<void>;
}

export interface JourneyScenarioResult {
  name: string;
  status: "completed" | "exited" | "failed";
  virtualDurationMs: number;
  mailbox: MailboxMessage[];
  triggers: CapturedTrigger[];
  checkpoints: CapturedCheckpoint[];
  timeline: TimelineEntry[];
  error?: unknown;
}

export interface JourneyScenarioSummary {
  outcomes: Record<JourneyScenarioResult["status"], number>;
  sends: Record<string, number>;
  triggers: Record<string, number>;
  checkpoints: Record<string, number>;
  virtualDurationMs: { min: number; average: number; max: number };
}

export interface JourneyScenarioRun {
  results: JourneyScenarioResult[];
  summary: JourneyScenarioSummary;
}

export interface SimulateJourneyOptions {
  /**
   * Run the journey even when the production enrollment guards would skip
   * this user. The verdict is still reported in `entry`.
   */
  force?: boolean;
}

/** A send attempt's outcome, as returned by the captured services. */
export type SimulationSendStatus =
  | "sent"
  | "suppressed"
  | "unsubscribed"
  | "no_consent"
  | "skipped";

/** One row of a simulation timeline. `at` is an ISO instant. */
export type SimulationStep =
  | {
      kind: "enrolled";
      at: string;
      event: string;
      properties: Record<string, unknown>;
    }
  | { kind: "skipped"; at: string; reason: string }
  | {
      kind: "event";
      at: string;
      event: string;
      userId: string;
      properties: Record<string, unknown>;
    }
  | {
      kind: "wait";
      at: string;
      wait: "sleep" | "sleepUntil" | "waitForEvent" | "digest";
      label: string;
      /** Planned length in ms (sleep, time to target, timeout or window). */
      durationMs?: number;
      /** `waitForEvent`/`digest` event name. */
      event?: string;
      /** `resumed` = timer elapsed; `matched` = event arrived. */
      outcome: "resumed" | "matched" | "timedOut" | "exited";
      resumedAt: string;
      /** `waitForEvent` match source: `forward`, `lookback` or `pending`. */
      source?: string;
    }
  | { kind: "checkpoint"; at: string; label: string }
  | { kind: "variant"; at: string; key: string; arm: string }
  | {
      kind: "send";
      at: string;
      channel: "email" | "sms" | "feed" | "connector";
      status: SimulationSendStatus;
      /** Template key; feed type for feed; `connectorId:action` for connectors. */
      template: string;
      to?: string;
      subject?: string;
      category?: string;
      reason?: string;
      idempotencyLabel?: string;
    }
  | {
      kind: "trigger";
      at: string;
      event: string;
      userId: string;
      properties: Record<string, unknown>;
    }
  | { kind: "guard"; at: string; subscribed: boolean }
  | {
      kind: "exit";
      at: string;
      source: "exitOn" | "manual";
      reason?: string;
    }
  | { kind: "completed"; at: string }
  | { kind: "failed"; at: string; error: string };

/** Stable, JSON-serializable report of one simulated journey run. */
export interface JourneySimulation {
  journey: {
    id: string;
    name: string;
    trigger: string;
    exitOn: string[];
  };
  scenario: string;
  user: { id: string; email: string };
  startedAt: string;
  endedAt: string;
  virtualDurationMs: number;
  status: "completed" | "exited" | "failed" | "skipped";
  /** Production enrollment-guard verdict for this user. */
  entry: { allowed: boolean; reason?: string; forced?: boolean };
  exit?: { source: "exitOn" | "manual"; reason?: string };
  error?: { name: string; message: string; stack?: string };
  steps: SimulationStep[];
  /** Scripted events timed after the run ended, so the journey never saw them. */
  notReached: Array<{ at: string; event: string }>;
  summary: {
    /** Delivered (captured) sends per channel. */
    sent: Record<"email" | "sms" | "feed" | "connector", number>;
    /** Send attempts blocked by preferences, consent or suppression. */
    blocked: number;
    triggers: number;
    waits: number;
  };
}

export type JourneyDefinition = {
  meta: JourneyMeta;
  run: import("@hogsend/core/types").JourneyRunFn;
};
