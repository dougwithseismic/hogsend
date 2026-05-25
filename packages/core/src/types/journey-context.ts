import type { DurationObject } from "../duration.js";
import type {
  EmailEngagementCondition,
  PropertyCondition,
} from "./conditions.js";
import type { JourneyUser } from "./journey.js";

export interface SleepOptions {
  duration: DurationObject;
  label?: string;
}

export interface SleepResult {
  sleptAt: string;
  resumedAt: string;
}

export interface EventCheckOptions {
  userId: string;
  event: string;
  withinHours?: number;
}

export interface EventCheckResult {
  found: boolean;
  count: number;
}

export interface EventFireOptions {
  userId: string;
  event: string;
  properties?: Record<string, unknown>;
}

export interface EventFireResult {
  eventKey: string;
  firedAt: string;
}

export interface SendEmailOptions {
  template: string;
  subject: string;
  props?: Record<string, unknown>;
  category?: string;
}

export interface SendEmailResult {
  emailId: string;
  sentAt: string;
}

export interface EngagementCheckOptions {
  templateKey: string;
  check: EmailEngagementCondition["check"];
}

export interface EngagementCheckResult {
  matched: boolean;
  check: EmailEngagementCondition["check"];
}

export interface PropertyCheckOptions {
  source: PropertyCondition["source"];
  property: string;
  operator: PropertyCondition["operator"];
  value?: PropertyCondition["value"];
}

export interface PropertyCheckResult {
  matched: boolean;
  actualValue?: unknown;
}

export interface WebhookOptions {
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface WebhookResult {
  statusCode: number;
}

export interface EnrollOptions {
  userId: string;
  userEmail: string;
  journeyId: string;
}

export interface EnrollResult {
  enrolledAt: string;
}

export interface JourneyContext {
  sleep(opts: SleepOptions): Promise<SleepResult>;
  checkpoint(label: string): Promise<void>;

  event: {
    check(opts: EventCheckOptions): Promise<EventCheckResult>;
    fire(opts: EventFireOptions): Promise<EventFireResult>;
  };

  email: {
    send(user: JourneyUser, opts: SendEmailOptions): Promise<SendEmailResult>;
    checkEngagement(
      opts: EngagementCheckOptions,
    ): Promise<EngagementCheckResult>;
  };

  property: {
    check(opts: PropertyCheckOptions): Promise<PropertyCheckResult>;
  };

  webhook: {
    send(opts: WebhookOptions): Promise<WebhookResult>;
  };

  journey: {
    enroll(opts: EnrollOptions): Promise<EnrollResult>;
  };
}

export type JourneyRunFn = (
  user: JourneyUser,
  ctx: JourneyContext,
) => Promise<void>;
