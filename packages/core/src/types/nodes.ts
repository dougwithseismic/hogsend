import type { JourneyAction } from "./actions.js";
import type { ConditionEval } from "./conditions.js";

export interface ActionNode {
  type: "action";
  id: string;
  action: JourneyAction;
  next: string | null;
}

export interface WaitNode {
  type: "wait";
  id: string;
  hours: number;
  next: string;
}

export interface ConditionNode {
  type: "condition";
  id: string;
  eval: ConditionEval;
  onTrue: string;
  onFalse: string;
}

export type JourneyNode = ActionNode | WaitNode | ConditionNode;
