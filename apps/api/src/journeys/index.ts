import { JourneyRegistry } from "@hogsend/core/registry";
import { activationWelcome } from "./activation-welcome.js";
import { testOnboarding } from "./test-onboarding.js";

const allJourneys = [activationWelcome, testOnboarding];

function parseEnabledFilter(value?: string): Set<string> | "*" {
  if (!value || value.trim() === "*") return "*";
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function createJourneyRegistry(enabledFilter?: string): JourneyRegistry {
  const registry = new JourneyRegistry();
  const enabled = parseEnabledFilter(enabledFilter);

  for (const journey of allJourneys) {
    if (enabled === "*" || enabled.has(journey.id)) {
      registry.register(journey);
    }
  }

  return registry;
}
