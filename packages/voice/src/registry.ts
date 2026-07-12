import { join } from "node:path";
import type {
  VoiceAgentDefinition,
  VoiceAgentName,
  VoiceAgentRegistry,
  VoiceAgentRegistryMap,
  VoiceTool,
  VoiceToolRegistry,
} from "./types.js";

// The registry holds no baked-in agents. Client apps build their own
// `VoiceAgentRegistry` (key → definition) and pass it to the engine's tracked
// voice sender, which threads it through at call-synthesis time.

/**
 * Resolve a voice-agent definition, throwing a loud, actionable error when the
 * key isn't registered — the runtime backstop behind the compile-time
 * `VoiceAgentName` typing. Uses `Object.hasOwn` (not value-truthiness) so a key
 * colliding with an inherited `Object.prototype` member is not waved through.
 */
function requireDefinition<K extends VoiceAgentName>(
  key: K,
  registry: VoiceAgentRegistry,
): VoiceAgentDefinition<VoiceAgentRegistryMap[K]> {
  if (!Object.hasOwn(registry, key)) {
    const known = Object.keys(registry);
    throw new Error(
      `Voice agent "${String(key)}" is not registered. Register it in your ` +
        "voice agent registry (registry.ts) and augment " +
        "`VoiceAgentRegistryMap` (templates.d.ts), or fix the key. " +
        `Registered agents: ${known.length ? known.join(", ") : "(none)"}.`,
    );
  }
  return registry[key] as VoiceAgentDefinition<VoiceAgentRegistryMap[K]>;
}

export function getVoiceAgentDefinition<K extends VoiceAgentName>(opts: {
  key: K;
  registry: VoiceAgentRegistry;
}): VoiceAgentDefinition<VoiceAgentRegistryMap[K]> {
  const { key, registry } = opts;
  return requireDefinition(key, registry);
}

export function createVoiceRegistry(
  base: VoiceAgentRegistry,
  overrides: Partial<VoiceAgentRegistry> = {},
): VoiceAgentRegistry {
  return { ...base, ...overrides };
}

export function getVoiceAgentNames(
  registry: VoiceAgentRegistry,
): VoiceAgentName[] {
  return Object.keys(registry) as VoiceAgentName[];
}

/**
 * Stamp a best-effort absolute `sourcePath` on every agent definition so the
 * Studio can deep-link the agent file. Pass the consumer's voice dir as `dir`
 * (use `import.meta.dirname` from the registry module). Leaf filename derived
 * from the key via `key.replace("/", "-") + ".ts"` (agents are `.ts`, not the
 * `.tsx` of email/SMS templates). Never throws.
 */
export function withSources(
  dir: string,
  registry: VoiceAgentRegistry,
): VoiceAgentRegistry {
  const out = { ...registry };
  const view = out as unknown as Record<string, VoiceAgentDefinition>;
  for (const key of Object.keys(view)) {
    const def = view[key];
    if (def && !def.sourcePath) {
      view[key] = {
        ...def,
        sourcePath: join(dir, `${key.replace(/\//g, "-")}.ts`),
      };
    }
  }
  return out;
}

/**
 * Index a list of tools by `spec.name` into a {@link VoiceToolRegistry} the
 * engine's mid-call dispatcher resolves against. Throws on a duplicate name so a
 * collision is caught at wiring time, not silently last-wins.
 */
export function createVoiceToolRegistry(tools: VoiceTool[]): VoiceToolRegistry {
  const registry: VoiceToolRegistry = {};
  for (const tool of tools) {
    const name = tool.spec.name;
    if (Object.hasOwn(registry, name)) {
      throw new Error(
        `Duplicate voice tool "${name}". Each tool's spec.name must be unique.`,
      );
    }
    registry[name] = tool;
  }
  return registry;
}
