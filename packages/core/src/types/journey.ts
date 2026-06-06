import type { DurationObject } from "../duration.js";
import type { PropertyCondition } from "./conditions.js";

export interface JourneyMeta {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  trigger: {
    event: string;
    where?: PropertyCondition[];
  };

  entryLimit: "once" | "once_per_period" | "unlimited";
  entryPeriod?: DurationObject;

  exitOn?: Array<{
    event: string;
    where?: PropertyCondition[];
  }>;

  suppress: DurationObject;

  // Bucket-reaction tagging (set by buildBucketReaction). Generated reactions
  // carry these so the worker's dwell-cron lookup and Studio bucket-detail
  // grouping can discover owned reactions by sourceBucketId.
  sourceBucketId?: string;
  reactionKind?: "enter" | "leave" | "dwell";
  dwellSchedule?: { label: string; after?: number; every?: number };
}

export interface JourneyUser {
  id: string;
  email: string;
  properties: Record<string, string | number | boolean | null>;
  stateId: string;
  journeyId: string;
  journeyName: string;
}
