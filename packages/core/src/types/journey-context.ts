import type { DurationObject } from "../duration.js";
import type { TimeZone } from "../schedule/tz.js";

export interface SleepOptions {
  duration: DurationObject;
  label?: string;
}

export interface SleepResult {
  sleptAt: string;
  resumedAt: string;
}

export interface SleepUntilOptions {
  label?: string;
}

export type Weekday =
  | "mon"
  | "tue"
  | "wed"
  | "thu"
  | "fri"
  | "sat"
  | "sun"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/** How to treat a resolved instant that is already in the past. */
export type IfPast = "next" | "now";

export interface TimeOfDayBuilder {
  /** Resolve to an absolute instant at `time` ("HH:mm") in the bound tz. */
  at(time: string): Date;
}

export interface WhenBuilder {
  /** Upcoming named weekday; chain `.at("HH:mm")`. */
  next(weekday: Weekday): TimeOfDayBuilder;
  /** Next occurrence of `time` local (today if future, else tomorrow). */
  nextLocal(time: string): Date;
  /** Tomorrow in the bound tz; chain `.at("HH:mm")`. */
  tomorrow(): TimeOfDayBuilder;
  /** `duration` from now, snapped to `.at("HH:mm")` on that day. */
  in(duration: DurationObject): TimeOfDayBuilder;
  /** Override the resolved user tz for this chain only. Returns a new builder. */
  tz(timezone: TimeZone): WhenBuilder;
  /** Override the default send window for this chain. Returns a new builder. */
  window(start: string, end: string): WhenBuilder;
  /** How to treat an already-past resolved time. Default "next". */
  ifPast(strategy: IfPast): WhenBuilder;
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

  /** Durable sleep until an absolute instant (`Date` or ISO string). */
  sleepUntil(at: Date | string, opts?: SleepUntilOptions): Promise<SleepResult>;

  /** Timezone-bound fluent scheduler. Always terminates in a `Date`. */
  when: WhenBuilder;

  checkpoint(label: string): Promise<void>;
  trigger(opts: TriggerOptions): Promise<void>;
  identify(properties: Record<string, unknown>): void;

  guard: {
    isSubscribed(): Promise<boolean>;
  };

  history: {
    hasEvent(opts: HasEventOptions): Promise<HasEventResult>;
    journey(opts: JourneyHistoryOptions): Promise<JourneyHistoryResult>;
    email(opts: EmailHistoryOptions): Promise<EmailHistoryResult>;
  };

  posthog: {
    capture(opts: {
      event: string;
      properties?: Record<string, unknown>;
    }): void;
  };
}

export type JourneyRunFn = (
  user: import("./journey.js").JourneyUser,
  ctx: JourneyContext,
) => Promise<void>;
