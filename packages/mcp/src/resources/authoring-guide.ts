/**
 * The `hogsend://blueprint-authoring-guide` MCP resource — the full Journey
 * Blueprint authoring vocabulary (graph shape, node/edge/condition reference,
 * durations, structural rules, the validate→iterate→write workflow). Loaded on
 * demand instead of taxing every conversation turn.
 *
 * The content is imported from `@hogsend/engine`'s env-free authoring-guide
 * LEAF module (`BLUEPRINT_AUTHORING_GUIDE`), the SAME constant the in-process
 * `blueprint-tools.ts` descriptions draw from, so this resource and the tool
 * descriptions can never drift. We import the leaf (not the barrel) so the
 * standalone stdio bin never evaluates the engine's server env validation.
 */
import { BLUEPRINT_AUTHORING_GUIDE } from "@hogsend/engine/mcp/authoring-guide";

export const AUTHORING_GUIDE_URI = "hogsend://blueprint-authoring-guide";

export const authoringGuideResource = {
  name: "blueprint-authoring-guide",
  uri: AUTHORING_GUIDE_URI,
  title: "Journey Blueprint authoring guide",
  description:
    "The full graph vocabulary for authoring Journey Blueprints with " +
    "manage_blueprint: node/edge/condition types, durations, structural rules, " +
    "and the validate→iterate→write workflow.",
  mimeType: "text/markdown",
  text: BLUEPRINT_AUTHORING_GUIDE,
} as const;
