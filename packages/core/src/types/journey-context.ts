import type { DurationObject } from "../duration.js";
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

export interface JourneyContext {
  sleep(opts: SleepOptions): Promise<SleepResult>;
  checkpoint(label: string): Promise<void>;

  event: {
    check(opts: EventCheckOptions): Promise<EventCheckResult>;
    fire(opts: EventFireOptions): Promise<EventFireResult>;
  };
}

export type JourneyRunFn = (
  user: JourneyUser,
  ctx: JourneyContext,
) => Promise<void>;
