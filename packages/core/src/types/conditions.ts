export interface PropertyCondition {
  type: "property";
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

import type { DurationObject } from "../duration.js";

export interface EventCondition {
  type: "event";
  eventName: string;
  check: "exists" | "not_exists" | "count";
  operator?: "gt" | "gte" | "lt" | "lte" | "eq";
  value?: number;
  within?: DurationObject;
}

export interface EmailEngagementCondition {
  type: "email_engagement";
  /**
   * Absent means "scoped by caller context" — campaign waves read it as "any
   * prior send of THIS campaign". The per-user evaluator has no such scope
   * and throws when it is absent.
   */
  templateKey?: string;
  check: "opened" | "clicked" | "not_opened" | "not_clicked";
}

/**
 * The member has / lacks a linked identity for a connector (v1: `"discord"`
 * → `contacts.discordId`). Bulk-only in v1: evaluated as SQL on the campaign
 * wave path; the per-user evaluator throws.
 */
export interface ChannelIdentityCondition {
  type: "channel_identity";
  connector: string;
  check: "linked" | "not_linked";
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
  | ChannelIdentityCondition
  | CompositeCondition;
