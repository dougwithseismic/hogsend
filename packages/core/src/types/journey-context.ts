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

export interface RecentEventsOptions {
  userId: string;
  limit?: number;
  within?: DurationObject;
}

export interface RecentEvent {
  event: string;
  properties: Record<string, unknown> | null;
  occurredAt: string;
}

export interface WaitForEventOptions {
  /** Event name to wait for (use your `Events` constant). Matched verbatim. */
  event: string;
  /**
   * Max time to wait before resolving as timed-out. Required: an unbounded wait
   * is only capped by the task's execution timeout and would fail rather than
   * resume. Keep it within the journey execution timeout (720h / 30 days).
   */
  timeout: DurationObject;
  /** Optional observability label written to `currentNodeId` while waiting. */
  label?: string;
  /**
   * Look BACK this far before waiting forward. The wait is normally
   * forward-looking (only events pushed after it is established match), which
   * leaves a gap: an event landing between two waits — or between a send and
   * its wait — is never seen. With `lookback`, recent `user_events` matching
   * (user, event) are checked first; a hit resolves immediately with
   * `{ timedOut: false, properties }`. Keep the window tight (just the gap it
   * covers, e.g. `hours(1)` between back-to-back waits) so a stale answer
   * isn't mistaken for a fresh one.
   */
  lookback?: DurationObject;
}

export interface WaitForEventResult {
  /** `true` when the `timeout` elapsed first; `false` when the event fired. */
  timedOut: boolean;
  /**
   * The matched event's properties, present (best-effort) when the event
   * branch fired and the pushed payload carried them. Scalars only — that is
   * all the ingest pipeline puts on the wire. Branch on these to react to the
   * answer (e.g. an in-email NPS score) without a separate history lookup.
   */
  properties?: Record<string, string | number | boolean | null>;
}

export interface JourneyContext {
  sleep(opts: SleepOptions): Promise<SleepResult>;

  /** Durable sleep until an absolute instant (`Date` or ISO string). */
  sleepUntil(at: Date | string, opts?: SleepUntilOptions): Promise<SleepResult>;

  /**
   * Durably wait until THIS user emits `event`, or `timeout` elapses —
   * whichever comes first. The state is marked `"waiting"` while suspended and
   * `"active"` again on resume. Returns `{ timedOut }` so the journey can branch
   * (e.g. send a nudge on timeout, do nothing if the event arrived).
   *
   * Forward-looking: only events emitted AFTER the wait is established count —
   * use `ctx.history.hasEvent` to check whether something already happened.
   *
   * If the journey exits (via `exitOn`) or is cancelled while waiting, the run
   * is aborted cleanly (a `JourneyExitedError` is thrown and handled by the
   * engine) so no post-wait side effects fire. After a long wait you should
   * still re-check `ctx.guard.isSubscribed()` before sending, since an
   * unsubscribe does not exit the journey.
   */
  waitForEvent(opts: WaitForEventOptions): Promise<WaitForEventResult>;

  /** Timezone-bound fluent scheduler. Always terminates in a `Date`. */
  when: WhenBuilder;

  checkpoint(label: string): Promise<void>;
  trigger(opts: TriggerOptions): Promise<void>;

  guard: {
    isSubscribed(): Promise<boolean>;
  };

  history: {
    hasEvent(opts: HasEventOptions): Promise<HasEventResult>;
    journey(opts: JourneyHistoryOptions): Promise<JourneyHistoryResult>;
    email(opts: EmailHistoryOptions): Promise<EmailHistoryResult>;
    events(opts: RecentEventsOptions): Promise<RecentEvent[]>;
  };
}

export type JourneyRunFn = (
  user: import("./journey.js").JourneyUser,
  ctx: JourneyContext,
) => Promise<void>;
