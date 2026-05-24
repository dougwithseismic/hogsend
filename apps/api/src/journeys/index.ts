import { JourneyRegistry } from "@hogsend/core/registry";
import { activationWelcome } from "./activation-welcome.js";
import { testOnboarding } from "./test-onboarding.js";

export function createJourneyRegistry(): JourneyRegistry {
  const registry = new JourneyRegistry();
  registry.register(activationWelcome);
  registry.register(testOnboarding);
  return registry;
}
