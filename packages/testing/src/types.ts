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
}

export interface TestEvent {
  event: string;
  properties: Record<string, unknown>;
  userId: string;
  userEmail?: string;
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
   * Global master subscription state. Scheduled changes also gate captured
   * recipient-directed effects after virtual time crosses their timestamp.
   */
  subscribed?: boolean;
  once?: Record<string, unknown>;
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
    | "guard";
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

export type JourneyDefinition = {
  meta: JourneyMeta;
  run: import("@hogsend/core/types").JourneyRunFn;
};
