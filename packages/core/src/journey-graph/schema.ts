import { z } from "zod";
import type { JourneyEdge, JourneyGraph, JourneyNode } from "./types.js";

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

export const journeyNodeSchema = z.object({
  id: z.string(),
  type: journeyNodeTypeSchema,
  title: z.string(),
  subtitle: z.string().optional(),
  meta: z
    .object({
      duration: z.record(z.string(), z.number()).optional(),
      timeout: z.record(z.string(), z.number()).optional(),
      event: z.string().optional(),
      template: z.string().optional(),
      idempotencyLabel: z.string().optional(),
      connectorId: z.string().optional(),
      action: z.string().optional(),
      conditions: z.array(z.unknown()).optional(),
      unstable: z.boolean().optional(),
    })
    .optional(),
  line: z.number().optional(),
});

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
// aligned with the hand-authored interfaces in types.ts (both directions).
type _AssertNode = [
  z.infer<typeof journeyNodeSchema> extends JourneyNode ? true : never,
  JourneyNode extends z.infer<typeof journeyNodeSchema> ? true : never,
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
const _assertEdge: _AssertEdge = [true, true];
const _assertGraph: _AssertGraph = [true, true];
void _assertNode;
void _assertEdge;
void _assertGraph;
