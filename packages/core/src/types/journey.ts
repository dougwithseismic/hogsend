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
  entryPeriodHours?: number;

  exitOn?: Array<{
    event: string;
    where?: PropertyCondition[];
  }>;

  suppressHours: number;
}

export interface JourneyUser {
  id: string;
  email: string;
  properties: Record<string, string | number | boolean | null>;
  stateId: string;
  journeyId: string;
  journeyName: string;
}
