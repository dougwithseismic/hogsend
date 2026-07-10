/**
 * `manage_journey` — the whole journey lifecycle behind ONE approval surface.
 * The safety contract lives in the design, not in trust:
 *   - `create` artifacts are BORN DISABLED (PUT ?enabled=false);
 *   - `enable` is the explicit go-live gate and demands a `confirm` echo of the
 *     user's words;
 *   - `disable` needs nothing (always-safe kill switch);
 *   - `rollback` is non-destructive (forward-roll; history preserved);
 *   - server-side validation errors are returned VERBATIM so the model can fix
 *     its spec and retry.
 */

import { journeySpecSchema } from "@hogsend/core";
import { z } from "zod";
import type { AdminClient } from "../client.js";
import { isHttpError } from "../client.js";
import { deepLink } from "../lib/format.js";
import { specWalkthrough } from "../lib/walkthrough.js";
import { type ToolDef, toolError, toolResult } from "../registry.js";

interface SpecSummary {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
}

interface GraphResponse {
  graph: { nodes: Array<{ id: string; type: string; title?: string }> };
}

function httpErrorText(err: unknown, fallback: string): string {
  if (isHttpError(err)) {
    const body = err.body as { error?: string } | undefined;
    return body?.error ?? err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

async function create(
  client: AdminClient,
  id: string,
  rawSpec: unknown,
  replace: boolean,
): Promise<ReturnType<typeof toolResult>> {
  // Validate locally first (fast, good messages), then let the server's
  // validateJourneySpec be the authority — its 400s come back verbatim.
  const parsed = journeySpecSchema.safeParse(rawSpec);
  if (!parsed.success) {
    return toolError(
      `Spec invalid (fix and retry — see the hogsend://journey-spec-reference resource):\n${parsed.error.issues
        .map((i) => `- ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  const spec = parsed.data;
  if (spec.id !== id) {
    return toolError(
      `The spec's id ("${spec.id}") must equal the \`id\` argument ("${id}").`,
    );
  }

  let summary: { spec: SpecSummary; created: boolean };
  try {
    summary = await client.put<{ spec: SpecSummary; created: boolean }>(
      `/v1/admin/journey-specs/${id}`,
      spec,
      // Born disabled on create; a replace keeps the existing live state.
      replace ? undefined : { enabled: "false" },
    );
  } catch (err) {
    if (isHttpError(err) && err.status === 409) {
      return toolError(
        `${httpErrorText(err, "conflict")}\nPick a different id (e.g. "${id}-v2") and retry.`,
      );
    }
    return toolError(httpErrorText(err, "create failed"));
  }

  const graph = await client
    .get<GraphResponse>(`/v1/admin/journeys/${id}/graph`)
    .catch(() => null);

  const walkthrough = specWalkthrough(spec);
  const state = summary.spec.enabled ? "ENABLED (live)" : "NOT live";
  return toolResult(
    [
      `Journey "${id}" ${summary.created ? "created" : `replaced (now version ${summary.spec.version})`} — ${state}.`,
      "",
      "What it will do:",
      walkthrough,
      "",
      summary.spec.enabled
        ? 'It is live now. Disable anytime with manage_journey(action: "disable").'
        : 'It is NOT live. Show the user this walkthrough; only after they explicitly approve, call manage_journey(action: "enable") with their words in `confirm`. To dry-run first: action "test" enrolls a test user.',
      `Studio: ${deepLink(client.baseUrl, `/journeys/${id}`)}`,
    ].join("\n"),
    {
      id,
      version: summary.spec.version,
      enabled: summary.spec.enabled,
      created: summary.created,
      walkthrough,
      graph: graph?.graph ?? null,
    },
  );
}

export const manageTool: ToolDef = {
  name: "manage_journey",
  title: "Manage a journey",
  tier: "write",
  description: [
    "Create and operate journeys (the write tool). Actions:",
    '- "create": author a new journey from a JSON spec (read the hogsend://journey-spec-reference resource first, and check scope "catalog" for valid template keys). The journey is created DISABLED and returns a plain-English walkthrough for the user to review. It sends nothing until enabled.',
    '- "update": replace an existing spec (bumps the version; old versions are kept).',
    '- "enable": turn a journey ON — the go-live step. ONLY call this after the user has explicitly approved in this conversation, and pass their approving words in `confirm`.',
    '- "disable": turn a journey OFF (kill switch — always safe, no confirmation needed).',
    '- "rollback": restore a prior version of a data-defined journey. Omit `version` to list available versions first.',
    '- "eject": generate the equivalent defineJourney() TypeScript for a data-defined journey (hand-off to developers).',
    '- "test": enroll one test user (testEmail) so the user can experience the journey end-to-end before enabling.',
    "Data-defined journeys only for create/update/rollback/eject; enable/disable also works for code journeys.",
  ].join("\n"),
  inputSchema: {
    action: z.enum([
      "create",
      "update",
      "enable",
      "disable",
      "rollback",
      "eject",
      "test",
    ]),
    id: z.string().describe("Journey id (kebab-case, e.g. activation-nudge)"),
    spec: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JourneySpec JSON — required for create/update"),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Target version for rollback (omit to list versions)"),
    confirm: z
      .string()
      .optional()
      .describe(
        "REQUIRED for enable: the user's own approving words from this conversation",
      ),
    testEmail: z
      .string()
      .optional()
      .describe("For action test: the address to enroll as a test user"),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("For action test: enrollment event properties"),
  },
  handler: async (args, client) => {
    const action = args.action as string;
    const id = args.id as string;
    if (!id) return toolError("`id` is required.");

    switch (action) {
      case "create":
      case "update": {
        if (!args.spec)
          return toolError(
            "`spec` is required for create/update — read the hogsend://journey-spec-reference resource for the format.",
          );
        return create(client, id, args.spec, action === "update");
      }

      case "enable": {
        const confirm = (args.confirm as string | undefined)?.trim();
        if (!confirm) {
          return toolError(
            "Refusing to enable without `confirm`. Ask the user to approve going live, then pass their approving words in `confirm`.",
          );
        }
        try {
          // Spec journeys PATCH journey-specs (also marks the runtime store
          // stale); code journeys PATCH the journeys config override.
          await client.patch(`/v1/admin/journey-specs/${id}`, {
            enabled: true,
          });
        } catch (err) {
          if (!(isHttpError(err) && err.status === 404)) {
            return toolError(httpErrorText(err, "enable failed"));
          }
          try {
            await client.patch(`/v1/admin/journeys/${id}`, { enabled: true });
          } catch (err2) {
            return toolError(httpErrorText(err2, "enable failed"));
          }
        }
        return toolResult(
          `Journey "${id}" is LIVE — it will enroll users on its trigger from now on (live within seconds).\nUndo anytime: manage_journey(action: "disable"). Previous versions remain available via rollback.`,
          { id, enabled: true },
        );
      }

      case "disable": {
        try {
          await client.patch(`/v1/admin/journey-specs/${id}`, {
            enabled: false,
          });
        } catch (err) {
          if (!(isHttpError(err) && err.status === 404)) {
            return toolError(httpErrorText(err, "disable failed"));
          }
          try {
            await client.patch(`/v1/admin/journeys/${id}`, { enabled: false });
          } catch (err2) {
            return toolError(httpErrorText(err2, "disable failed"));
          }
        }
        return toolResult(
          `Journey "${id}" is disabled — no new enrollments. Existing in-flight enrollments continue; cancel them individually in Studio if needed.`,
          { id, enabled: false },
        );
      }

      case "rollback": {
        if (args.version === undefined) {
          const versions = await client.get<{
            versions: Array<{ version: number; createdAt: string }>;
          }>(`/v1/admin/journey-specs/${id}/versions`);
          return toolResult(
            `Available versions of "${id}" (newest first):\n${versions.versions
              .map((v) => `- v${v.version} (${v.createdAt})`)
              .join(
                "\n",
              )}\nCall again with \`version\` to restore one (restores as a NEW version — nothing is destroyed).`,
            { id, versions: versions.versions },
          );
        }
        try {
          const res = await client.post<{ spec: SpecSummary }>(
            `/v1/admin/journey-specs/${id}/rollback`,
            { version: args.version },
          );
          return toolResult(
            `Rolled "${id}" back to the content of v${args.version} — now live as version ${res.spec.version} (${res.spec.enabled ? "enabled" : "disabled"}).`,
            { id, version: res.spec.version, enabled: res.spec.enabled },
          );
        } catch (err) {
          return toolError(httpErrorText(err, "rollback failed"));
        }
      }

      case "eject": {
        try {
          const res = await client.get<{ filename: string; code: string }>(
            `/v1/admin/journey-specs/${id}/eject`,
          );
          return toolResult(
            `Generated ${res.filename} — the equivalent code journey (hand to a developer to commit; the data version keeps running until they remove it):\n\n${res.code}`,
            { filename: res.filename, code: res.code },
          );
        } catch (err) {
          return toolError(httpErrorText(err, "eject failed"));
        }
      }

      case "test": {
        const email = args.testEmail as string | undefined;
        if (!email)
          return toolError("`testEmail` is required for action test.");
        try {
          const res = await client.post<{ enrolled: boolean; event: string }>(
            `/v1/admin/journeys/${id}/enroll`,
            {
              userId: `mcp-test-${email}`,
              userEmail: email,
              properties: args.properties ?? {},
            },
          );
          return toolResult(
            `Test enrollment dispatched for ${email} (trigger event "${res.event}"). NOTE: a disabled journey skips enrollment — enable it first, test, then disable again if you want a pre-launch dry run; or use send_test_email to review a single email instead.`,
            { id, email, event: res.event },
          );
        } catch (err) {
          return toolError(httpErrorText(err, "test enrollment failed"));
        }
      }

      default:
        return toolError(`Unknown action "${action}"`);
    }
  },
};
