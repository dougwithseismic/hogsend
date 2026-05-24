export interface PropertyCondition {
  type: "property";
  source: "posthog" | "context";
  property: string;
  operator:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "exists"
    | "not_exists"
    | "contains";
  value?: string | number | boolean;
}

export interface EventCondition {
  type: "event";
  eventName: string;
  check: "exists" | "not_exists" | "count";
  operator?: "gt" | "gte" | "lt" | "lte" | "eq";
  value?: number;
  withinHours?: number;
}

export interface EmailEngagementCondition {
  type: "email_engagement";
  templateKey: string;
  check: "opened" | "clicked" | "not_opened" | "not_clicked";
}

export interface CompositeCondition {
  type: "composite";
  operator: "and" | "or";
  conditions: ConditionEval[];
}

export type ConditionEval =
  | PropertyCondition
  | EventCondition
  | EmailEngagementCondition
  | CompositeCondition;
