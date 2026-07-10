import type { JourneyDetail } from "@/lib/admin-api";
import { DefinitionRows } from "./meta-row";

/**
 * The journey's authored definition (trigger, exits, entry limit, suppress) —
 * the caller provides the chrome (card, side panel, …). A thin adapter over
 * `DefinitionRows`: a journey's trigger is nested (`{event, where}`), which
 * `DefinitionRows` wants flattened.
 */
export function JourneyDefinition({ journey }: { journey: JourneyDetail }) {
  return (
    <DefinitionRows
      description={journey.description}
      triggerEvent={journey.trigger.event}
      triggerWhere={journey.trigger.where}
      exitOn={journey.exitOn}
      entryLimit={journey.entryLimit}
      suppress={journey.suppress}
    />
  );
}
