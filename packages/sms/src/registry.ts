import { join } from "node:path";
import type { ReactElement } from "react";
import type {
  SmsTemplateDefinition,
  SmsTemplateName,
  SmsTemplateRegistry,
  SmsTemplateRegistryMap,
} from "./types.js";

// The registry holds no baked-in templates. Client apps build their own
// `SmsTemplateRegistry` (key → component + category) and pass it to the engine's
// tracked SMS sender, which threads it through at send + render time.

/**
 * Resolve an SMS template definition, throwing a loud, actionable error when the
 * key isn't registered — the runtime backstop behind the compile-time
 * `SmsTemplateName` typing. Uses `Object.hasOwn` (not value-truthiness) so a key
 * colliding with an inherited `Object.prototype` member is not waved through.
 */
function requireDefinition<K extends SmsTemplateName>(
  key: K,
  registry: SmsTemplateRegistry,
): SmsTemplateDefinition<SmsTemplateRegistryMap[K]> {
  if (!Object.hasOwn(registry, key)) {
    const known = Object.keys(registry);
    throw new Error(
      `SMS template "${String(key)}" is not registered. Register it in your ` +
        "SMS template registry (registry.ts) and augment " +
        "`SmsTemplateRegistryMap` (templates.d.ts), or fix the key. " +
        `Registered templates: ${known.length ? known.join(", ") : "(none)"}.`,
    );
  }
  return registry[key] as SmsTemplateDefinition<SmsTemplateRegistryMap[K]>;
}

export function getSmsTemplate<K extends SmsTemplateName>(opts: {
  key: K;
  props: SmsTemplateRegistryMap[K];
  registry: SmsTemplateRegistry;
}): { element: ReactElement; category?: string } {
  const { key, props, registry } = opts;
  const definition = requireDefinition(key, registry);
  return {
    element: definition.component(props) as ReactElement,
    category: definition.category,
  };
}

export function getSmsTemplateDefinition<K extends SmsTemplateName>(opts: {
  key: K;
  registry: SmsTemplateRegistry;
}): SmsTemplateDefinition<SmsTemplateRegistryMap[K]> {
  const { key, registry } = opts;
  return requireDefinition(key, registry);
}

export function getSmsPreviewText<K extends SmsTemplateName>(opts: {
  key: K;
  props: SmsTemplateRegistryMap[K];
  registry: SmsTemplateRegistry;
}): string | undefined {
  const { key, props, registry } = opts;
  const definition = requireDefinition(key, registry);
  return definition.preview?.(props);
}

export function createSmsRegistry(
  base: SmsTemplateRegistry,
  overrides: Partial<SmsTemplateRegistry> = {},
): SmsTemplateRegistry {
  return { ...base, ...overrides };
}

export function getSmsTemplateNames(
  registry: SmsTemplateRegistry,
): SmsTemplateName[] {
  return Object.keys(registry) as SmsTemplateName[];
}

/**
 * Stamp a best-effort absolute `sourcePath` on every template definition so the
 * Studio can deep-link the component file. Pass the consumer's SMS dir as `dir`
 * (use `import.meta.dirname` from the registry module). Leaf filename derived
 * from the key via `key.replace("/", "-") + ".tsx"`. Never throws.
 */
export function withSources(
  dir: string,
  registry: SmsTemplateRegistry,
): SmsTemplateRegistry {
  const out = { ...registry };
  const view = out as unknown as Record<string, SmsTemplateDefinition>;
  for (const key of Object.keys(view)) {
    const def = view[key];
    if (def && !def.sourcePath) {
      view[key] = {
        ...def,
        sourcePath: join(dir, `${key.replace(/\//g, "-")}.tsx`),
      };
    }
  }
  return out;
}
