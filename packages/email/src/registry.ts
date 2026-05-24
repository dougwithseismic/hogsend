import type { ReactElement } from "react";
import JourneyNotificationEmail from "../emails/journey-notification.js";
import PasswordResetEmail from "../emails/password-reset.js";
import WelcomeEmail from "../emails/welcome.js";
import type {
  TemplateDefinition,
  TemplateMap,
  TemplateName,
  TemplateRegistry,
} from "./types.js";

const defaultRegistry: TemplateRegistry = {
  welcome: {
    component: WelcomeEmail,
    defaultSubject: "Welcome to Hogsend",
    category: "transactional",
    preview: (props) => `Welcome to Hogsend, ${props.name}!`,
  },
  "password-reset": {
    component: PasswordResetEmail,
    defaultSubject: "Reset your password",
    category: "transactional",
    preview: () => "Reset your Hogsend password",
  },
  "journey-notification": {
    component: JourneyNotificationEmail,
    defaultSubject: "Journey notification",
    category: "journey",
    preview: (props) => `${props.journeyName}: ${props.eventName}`,
  },
};

export function getTemplate<K extends TemplateName>(
  key: K,
  props: TemplateMap[K],
  registry: TemplateRegistry = defaultRegistry,
): { element: ReactElement; subject: string; category?: string } {
  const definition = registry[key] as TemplateDefinition<TemplateMap[K]>;

  return {
    element: definition.component(props) as ReactElement,
    subject: definition.defaultSubject,
    category: definition.category,
  };
}

export function getTemplateDefinition<K extends TemplateName>(
  key: K,
  registry: TemplateRegistry = defaultRegistry,
): TemplateDefinition<TemplateMap[K]> {
  return registry[key] as TemplateDefinition<TemplateMap[K]>;
}

export function getPreviewText<K extends TemplateName>(
  key: K,
  props: TemplateMap[K],
  registry: TemplateRegistry = defaultRegistry,
): string | undefined {
  const definition = registry[key] as TemplateDefinition<TemplateMap[K]>;
  return definition.preview?.(props);
}

export function createRegistry(
  overrides: Partial<TemplateRegistry>,
): TemplateRegistry {
  return { ...defaultRegistry, ...overrides };
}

export function getTemplateNames(
  registry: TemplateRegistry = defaultRegistry,
): TemplateName[] {
  return Object.keys(registry) as TemplateName[];
}

export { defaultRegistry };
