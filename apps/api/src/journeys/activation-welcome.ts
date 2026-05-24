import type { JourneyDefinition } from "@hogsend/core/types";

export const activationWelcome: JourneyDefinition = {
  id: "activation-welcome",
  name: "Activation — Welcome Series",
  enabled: true,

  trigger: { event: "user.created" },
  entryLimit: "once",
  suppressHours: 12,
  exitOn: [{ event: "user.deleted" }],

  entryNode: "send_welcome",

  nodes: {
    send_welcome: {
      type: "action",
      id: "send_welcome",
      action: {
        type: "send_email",
        templateKey: "activation/welcome",
        subject: "Welcome to Hogsend — let's get you set up",
      },
      next: "wait_48h",
    },

    wait_48h: {
      type: "wait",
      id: "wait_48h",
      hours: 48,
      next: "check_engagement",
    },

    check_engagement: {
      type: "condition",
      id: "check_engagement",
      eval: {
        type: "event",
        eventName: "feature.used",
        check: "exists",
      },
      onTrue: "send_advanced",
      onFalse: "send_nudge",
    },

    send_advanced: {
      type: "action",
      id: "send_advanced",
      action: {
        type: "send_email",
        templateKey: "activation/advanced",
        subject: "Nice work — here's what to try next",
      },
      next: "wait_48h_2",
    },

    send_nudge: {
      type: "action",
      id: "send_nudge",
      action: {
        type: "send_email",
        templateKey: "activation/nudge",
        subject: "You haven't tried the key feature yet",
      },
      next: "wait_48h_2",
    },

    wait_48h_2: {
      type: "wait",
      id: "wait_48h_2",
      hours: 48,
      next: "send_community",
    },

    send_community: {
      type: "action",
      id: "send_community",
      action: {
        type: "send_email",
        templateKey: "activation/community",
        subject: "Join the community",
      },
      next: null,
    },
  },
};
