import type { JourneyDefinition } from "@hogsend/core/types";

export const testOnboarding: JourneyDefinition = {
  id: "test-onboarding",
  name: "Test — Onboarding Flow",
  enabled: true,

  trigger: { event: "test.signup" },
  entryLimit: "unlimited",
  suppressHours: 0,

  entryNode: "log_welcome",

  nodes: {
    log_welcome: {
      type: "action",
      id: "log_welcome",
      action: {
        type: "fire_event",
        eventName: "journey.welcome_fired",
        properties: { step: "welcome" },
      },
      next: "check_plan",
    },

    check_plan: {
      type: "condition",
      id: "check_plan",
      eval: {
        type: "property",
        source: "context",
        property: "plan",
        operator: "eq",
        value: "pro",
      },
      onTrue: "log_pro",
      onFalse: "log_free",
    },

    log_pro: {
      type: "action",
      id: "log_pro",
      action: {
        type: "fire_event",
        eventName: "journey.pro_path",
        properties: { step: "pro_branch" },
      },
      next: "log_complete",
    },

    log_free: {
      type: "action",
      id: "log_free",
      action: {
        type: "fire_event",
        eventName: "journey.free_path",
        properties: { step: "free_branch" },
      },
      next: "log_complete",
    },

    log_complete: {
      type: "action",
      id: "log_complete",
      action: {
        type: "fire_event",
        eventName: "journey.completed",
        properties: { step: "done" },
      },
      next: null,
    },
  },
};
