import type { PropertyCondition } from "./conditions.js";
import type { JourneyNode } from "./nodes.js";

export interface JourneyDefinition {
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

  entryNode: string;

  nodes: Record<string, JourneyNode>;
}
