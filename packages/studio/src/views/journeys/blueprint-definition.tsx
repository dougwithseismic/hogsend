import type { BlueprintDetail } from "@/lib/admin-api";
import { DefinitionRows, MetaRow } from "./meta-row";

const SOURCE_LABEL: Record<BlueprintDetail["source"], string> = {
  mcp: "MCP",
  studio: "Studio",
  api: "API",
};

/**
 * A blueprint's authored definition — same shape as `JourneyDefinition`
 * (trigger, exits, entry limit, suppress) via the shared `DefinitionRows`,
 * plus a Source row (version/author/origin) a code journey doesn't carry.
 */
export function BlueprintDefinition({
  blueprint,
}: {
  blueprint: BlueprintDetail;
}) {
  return (
    <DefinitionRows
      description={blueprint.description}
      triggerEvent={blueprint.triggerEvent}
      triggerWhere={blueprint.triggerWhere ?? undefined}
      exitOn={blueprint.exitOn}
      entryLimit={blueprint.entryLimit}
      entryPeriod={blueprint.entryPeriod}
      suppress={blueprint.suppress}
      extra={
        <MetaRow label="Source">
          {SOURCE_LABEL[blueprint.source]} · v{blueprint.version}
          {blueprint.createdBy ? ` · ${blueprint.createdBy}` : ""}
        </MetaRow>
      }
    />
  );
}
