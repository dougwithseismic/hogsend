import type { DurationObject } from "../duration.js";

export interface SleepOptions {
  duration: DurationObject;
  label?: string;
}

export interface SleepResult {
  sleptAt: string;
  resumedAt: string;
}

export interface TriggerOptions {
  event: string;
  userId: string;
  userEmail?: string;
  properties?: Record<string, unknown>;
}

export interface HasEventOptions {
  userId: string;
  event: string;
  within?: DurationObject;
}

export interface HasEventResult {
  found: boolean;
  count: number;
}

export interface JourneyHistoryOptions {
  userId: string;
  journeyId: string;
}

export interface JourneyHistoryResult {
  completed: boolean;
  lastCompletedAt: string | null;
  entryCount: number;
}

export interface EmailHistoryOptions {
  email: string;
  template: string;
}

export interface EmailHistoryResult {
  sent: boolean;
  lastSentAt: string | null;
  count: number;
}

export interface JourneyContext {
  sleep(opts: SleepOptions): Promise<SleepResult>;
  checkpoint(label: string): Promise<void>;
  trigger(opts: TriggerOptions): Promise<void>;

  guard: {
    isSubscribed(): Promise<boolean>;
  };

  history: {
    hasEvent(opts: HasEventOptions): Promise<HasEventResult>;
    journey(opts: JourneyHistoryOptions): Promise<JourneyHistoryResult>;
    email(opts: EmailHistoryOptions): Promise<EmailHistoryResult>;
  };
}

export type JourneyRunFn = (
  user: import("./journey.js").JourneyUser,
  ctx: JourneyContext,
) => Promise<void>;
