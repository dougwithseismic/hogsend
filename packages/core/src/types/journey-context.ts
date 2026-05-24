import type {
  EmailEngagementCondition,
  PropertyCondition,
} from "./conditions.js";
import type { JourneyUser } from "./journey.js";

export interface SendEmailOptions {
  template: string;
  subject: string;
  props?: Record<string, unknown>;
  category?: string;
}

export interface JourneyContext {
  sendEmail(
    user: JourneyUser,
    options: SendEmailOptions,
  ): Promise<{ emailId: string }>;

  hasEvent(
    userId: string,
    eventName: string,
    opts?: { withinHours?: number },
  ): Promise<boolean>;

  checkProperty(
    source: PropertyCondition["source"],
    property: string,
    operator: PropertyCondition["operator"],
    value?: PropertyCondition["value"],
  ): Promise<boolean>;

  checkEmailEngagement(
    templateKey: string,
    check: EmailEngagementCondition["check"],
  ): Promise<boolean>;

  fireEvent(
    userId: string,
    eventName: string,
    properties?: Record<string, unknown>,
  ): Promise<void>;

  webhook(
    url: string,
    opts?: {
      method?: "POST" | "PUT";
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    },
  ): Promise<void>;

  enrollJourney(
    userId: string,
    userEmail: string,
    journeyId: string,
  ): Promise<void>;

  sleepFor(duration: string, label?: string): Promise<void>;

  checkpoint(label: string): Promise<void>;
}

export type JourneyRunFn = (
  user: JourneyUser,
  ctx: JourneyContext,
) => Promise<void>;
