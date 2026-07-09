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

/**
 * Resolve a template definition, throwing a loud, actionable error when the key
 * isn't registered. This is the RUNTIME backstop behind the compile-time
 * `TemplateName` typing on `send()`/`sendEmail()`: statically-known keys are
 * caught by tsc, but keys resolved dynamically (the public `POST /v1/emails`,
 * an admin preview by id) reach here as plain strings. Without this guard a
 * missing key surfaced as a cryptic `Cannot read properties of undefined
 * (reading 'component')` deep in the render path — now it fails here, naming
 * the bad key and the registered ones.
 */
function requireDefinition<K extends TemplateName>(
  key: K,
  registry: TemplateRegistry,
): TemplateDefinition<TemplateRegistryMap[K]> {
  // Own-property check (NOT value-truthiness): a key resolved dynamically could
  // collide with an inherited `Object.prototype` member (`toString`,
  // `constructor`, `valueOf`, …). `registry["toString"]` is truthy but is NOT a
  // registered template, so `if (!definition)` would wave it through and the
  // cryptic render-path crash would resurface. `Object.hasOwn` is the correct
  // "is this key registered" test.
  if (!Object.hasOwn(registry, key)) {
    const known = Object.keys(registry);
    throw new Error(
      `Email template "${String(key)}" is not registered. Register it in your ` +
        "template registry (registry.ts) and augment `TemplateRegistryMap` " +
        "(templates.d.ts), or fix the key. Registered templates: " +
        `${known.length ? known.join(", ") : "(none)"}.`,
    );
  }
  return registry[key] as TemplateDefinition<TemplateRegistryMap[K]>;
}

export function getTemplate<K extends TemplateName>(opts: {
  key: K;
  props: TemplateRegistryMap[K];
  registry: TemplateRegistry;
}): { element: ReactElement; subject: string; category?: string } {
  const { key, props, registry } = opts;
  const definition = requireDefinition(key, registry);

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
  return requireDefinition(key, registry);
}

export function getPreviewText<K extends TemplateName>(opts: {
  key: K;
  props: TemplateRegistryMap[K];
  registry: TemplateRegistry;
}): string | undefined {
  const { key, props, registry } = opts;
  const definition = requireDefinition(key, registry);
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
