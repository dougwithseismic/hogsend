/**
 * The `find_and_fix_bottleneck` MCP prompt — an argument-less canned
 * orchestration that bakes the safety contract into the default path: report →
 * explain the worst finding in plain language → propose a fix as a DRAFT
 * blueprint → WAIT for explicit user approval before enabling. The agent must
 * never enable a blueprint without the user saying so.
 */

export const FIND_AND_FIX_PROMPT_NAME = "find_and_fix_bottleneck";

export const FIND_AND_FIX_MESSAGE = `You are helping operate a Hogsend lifecycle-orchestration instance. Find the single biggest lifecycle bottleneck and propose a fix — SAFELY. Follow these steps in order:

1. Run \`hogsend_report\` across the relevant scopes to gather evidence: start with \`health\`, then \`deliverability\`, \`journeys\`, and \`blueprints\`. Use \`catalog\` if you need the registered template keys or the observed event-name vocabulary.

2. Identify the SINGLE worst finding (critical outranks warning outranks info; break ties by how much traffic it affects). Explain it to the user in plain language: what is happening, the evidence, and why it matters. Do not dump the raw report.

3. If the fix is a lifecycle automation, design it as a Journey Blueprint and propose it as a DRAFT: iterate with \`manage_blueprint\` action=validate until the graph is valid (read the \`hogsend://blueprint-authoring-guide\` resource for the vocabulary), then create it with action=create and status="draft" (never "enabled"). Present the proposed blueprint and explain exactly what it will do.

4. STOP and wait for the user's explicit approval. Only after the user clearly says to go live may you call \`manage_blueprint\` action=enable. Never enable a blueprint on your own initiative, and never use it to send real email without consent. \`send_test_email\` reaches a real inbox — only use it if the user asks.

If the best fix is not a blueprint (e.g. a setup/deliverability problem surfaced by the \`health\` or \`deliverability\` scope), explain the remediation and point at the relevant tool or the \`hogsend blueprints promote\` CLI where appropriate, rather than authoring a blueprint.`;

export const findAndFixPrompt = {
  name: FIND_AND_FIX_PROMPT_NAME,
  title: "Find and fix a lifecycle bottleneck",
  description:
    "Run the health report, explain the worst finding, and propose a fix as a " +
    "DRAFT blueprint — waiting for explicit user approval before enabling anything.",
  message: FIND_AND_FIX_MESSAGE,
} as const;
