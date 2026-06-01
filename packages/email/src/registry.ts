import type { ReactElement } from "react";
import type {
  TemplateDefinition,
  TemplateName,
  TemplateRegistry,
  TemplateRegistryMap,
} from "./types.js";

// The registry holds no baked-in business templates. Client apps build their
// own `TemplateRegistry` (key → component + subject + category) and pass it to
// these helpers — see the engine `TrackedMailer`, which threads the
// container-provided registry through at send + render time.

export function getTemplate<K extends TemplateName>(opts: {
  key: K;
  props: TemplateRegistryMap[K];
  registry: TemplateRegistry;
}): { element: ReactElement; subject: string; category?: string } {
  const { key, props, registry } = opts;
  const definition = registry[key] as TemplateDefinition<
    TemplateRegistryMap[K]
  >;

  return {
    element: definition.component(props) as ReactElement,
    subject: definition.defaultSubject,
    category: definition.category,
  };
}

export function getTemplateDefinition<K extends TemplateName>(opts: {
  key: K;
  registry: TemplateRegistry;
}): TemplateDefinition<TemplateRegistryMap[K]> {
  const { key, registry } = opts;
  return registry[key] as TemplateDefinition<TemplateRegistryMap[K]>;
}

export function getPreviewText<K extends TemplateName>(opts: {
  key: K;
  props: TemplateRegistryMap[K];
  registry: TemplateRegistry;
}): string | undefined {
  const { key, props, registry } = opts;
  const definition = registry[key] as TemplateDefinition<
    TemplateRegistryMap[K]
  >;
  return definition.preview?.(props);
}

/**
 * Merge partial registry overrides over a base registry. Useful for clients
 * that want to tweak a few templates while inheriting the rest of a starter
 * set.
 */
export function createRegistry(
  base: TemplateRegistry,
  overrides: Partial<TemplateRegistry> = {},
): TemplateRegistry {
  return { ...base, ...overrides };
}

export function getTemplateNames(registry: TemplateRegistry): TemplateName[] {
  return Object.keys(registry) as TemplateName[];
}
