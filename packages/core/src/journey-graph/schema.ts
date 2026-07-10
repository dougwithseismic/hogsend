import { z } from "zod";
import {
  conditionEvalSchema,
  propertyConditionSchema,
} from "../schemas/journey.schema.js";
import type {
  JourneyEdge,
  JourneyGraph,
  JourneyNode,
  JourneyNodeType,
} from "./types.js";

export const journeyNodeTypeSchema = z.enum([
  "start",
  "sleep",
  "sleepUntil",
  "wait",
  "digest",
  "send",
  "connector",
  "checkpoint",
  "trigger",
  "capture",
  "branch",
  "decision",
  "end-completed",
  "end-exited",
  "end-failed",
  "unknown",
]);

const durationRecordSchema = z.record(z.string(), z.number());

/** Meta flags shared by every node variant (see `JourneyNodeMetaBase`). */
const nodeMetaBaseSchema = z.object({
  unstable: z.boolean().optional(),
});

/** Fields shared by every node variant (see `JourneyNodeBase`). */
const nodeBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  line: z.number().optional(),
});

export const journeyStartNodeSchema = nodeBaseSchema.extend({
  type: z.literal("start"),
  meta: nodeMetaBaseSchema
    .extend({ conditions: z.array(propertyConditionSchema).optional() })
    .optional(),
});

export const journeySleepNodeSchema = nodeBaseSchema.extend({
  type: z.literal("sleep"),
  meta: nodeMetaBaseSchema
    .extend({ duration: durationRecordSchema.optional() })
    .optional(),
});

export const journeySleepUntilNodeSchema = nodeBaseSchema.extend({
  type: z.literal("sleepUntil"),
  meta: nodeMetaBaseSchema.optional(),
});

export const journeyWaitNodeSchema = nodeBaseSchema.extend({
  type: z.literal("wait"),
  meta: nodeMetaBaseSchema
    .extend({
      event: z.string().optional(),
      timeout: durationRecordSchema.optional(),
    })
    .optional(),
});

export const journeyDigestNodeSchema = nodeBaseSchema.extend({
  type: z.literal("digest"),
  meta: nodeMetaBaseSchema
    .extend({
      event: z.string().optional(),
      duration: durationRecordSchema.optional(),
    })
    .optional(),
});

export const journeySendNodeSchema = nodeBaseSchema.extend({
  type: z.literal("send"),
  meta: nodeMetaBaseSchema
    .extend({
      template: z.string().optional(),
      idempotencyLabel: z.string().optional(),
    })
    .optional(),
});

export const journeyConnectorNodeSchema = nodeBaseSchema.extend({
  type: z.literal("connector"),
  meta: nodeMetaBaseSchema
    .extend({
      connectorId: z.string().optional(),
      action: z.string().optional(),
    })
    .optional(),
});

export const journeyCheckpointNodeSchema = nodeBaseSchema.extend({
  type: z.literal("checkpoint"),
  meta: nodeMetaBaseSchema.optional(),
});

export const journeyTriggerNodeSchema = nodeBaseSchema.extend({
  type: z.literal("trigger"),
  meta: nodeMetaBaseSchema.extend({ event: z.string().optional() }).optional(),
});

export const journeyCaptureNodeSchema = nodeBaseSchema.extend({
  type: z.literal("capture"),
  meta: nodeMetaBaseSchema.optional(),
});

export const journeyDecisionNodeSchema = nodeBaseSchema.extend({
  type: z.literal(["branch", "decision"]),
  meta: nodeMetaBaseSchema
    .extend({ conditions: z.array(conditionEvalSchema).optional() })
    .optional(),
});

export const journeyEndNodeSchema = nodeBaseSchema.extend({
  type: z.literal(["end-completed", "end-exited", "end-failed"]),
  meta: nodeMetaBaseSchema.optional(),
});

export const journeyUnknownNodeSchema = nodeBaseSchema.extend({
  type: z.literal("unknown"),
  meta: nodeMetaBaseSchema.catchall(z.unknown()).optional(),
});

/**
 * Discriminated on `type` — the validator knows which variant it is validating
 * before it validates it, so failures report per-branch, per-field paths
 * ("nodes[3].meta.template") instead of a generic whole-object error.
 */
export const journeyNodeSchema = z.discriminatedUnion("type", [
  journeyStartNodeSchema,
  journeySleepNodeSchema,
  journeySleepUntilNodeSchema,
  journeyWaitNodeSchema,
  journeyDigestNodeSchema,
  journeySendNodeSchema,
  journeyConnectorNodeSchema,
  journeyCheckpointNodeSchema,
  journeyTriggerNodeSchema,
  journeyCaptureNodeSchema,
  journeyDecisionNodeSchema,
  journeyEndNodeSchema,
  journeyUnknownNodeSchema,
]);

export const journeyEdgeKindSchema = z.enum([
  "default",
  "timedOut",
  "answered",
  "conditional-true",
  "conditional-false",
]);

export const journeyEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  kind: journeyEdgeKindSchema.optional(),
});

export const journeySourceLocationSchema = z.object({
  path: z.string(),
  line: z.number(),
});

export const journeyGraphSchema = z.object({
  journeyId: z.string(),
  source: journeySourceLocationSchema.optional(),
  nodes: z.array(journeyNodeSchema),
  edges: z.array(journeyEdgeSchema),
  degraded: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
});

// Compile-time cross-check: the inferred schema types stay structurally
// aligned with the hand-authored interfaces in types.ts (both directions),
// and the standalone JourneyNodeType union stays in lockstep with the
// discriminated union's `type` members.
type _AssertNode = [
  z.infer<typeof journeyNodeSchema> extends JourneyNode ? true : never,
  JourneyNode extends z.infer<typeof journeyNodeSchema> ? true : never,
];
type _AssertNodeType = [
  JourneyNode["type"] extends JourneyNodeType ? true : never,
  JourneyNodeType extends JourneyNode["type"] ? true : never,
  z.infer<typeof journeyNodeTypeSchema> extends JourneyNodeType ? true : never,
  JourneyNodeType extends z.infer<typeof journeyNodeTypeSchema> ? true : never,
];
type _AssertEdge = [
  z.infer<typeof journeyEdgeSchema> extends JourneyEdge ? true : never,
  JourneyEdge extends z.infer<typeof journeyEdgeSchema> ? true : never,
];
type _AssertGraph = [
  z.infer<typeof journeyGraphSchema> extends JourneyGraph ? true : never,
  JourneyGraph extends z.infer<typeof journeyGraphSchema> ? true : never,
];

const _assertNode: _AssertNode = [true, true];
const _assertNodeType: _AssertNodeType = [true, true, true, true];
const _assertEdge: _AssertEdge = [true, true];
const _assertGraph: _AssertGraph = [true, true];
void _assertNode;
void _assertNodeType;
void _assertEdge;
void _assertGraph;
