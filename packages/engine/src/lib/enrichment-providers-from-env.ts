import type { EnrichmentProvider } from "@hogsend/core";
import type { env as envSchema } from "../env.js";

/**
 * `@hogsend/plugin-apollo` is an OPT-IN, deferred-publish package — an engine
 * `optionalDependency`, NOT a hard one. Mirroring the Postmark/Twilio pattern
 * in `email-providers-from-env.ts` / `sms-providers-from-env.ts`, we MUST NOT
 * statically import it: a static import would make the package mandatory at
 * engine load and break `npm install @hogsend/engine` for every consumer
 * without it.
 *
 * Instead we load it lazily, ONCE, behind a top-level guarded dynamic import
 * gated on `APOLLO_API_KEY` being present. The specifier is assembled at
 * runtime (not a literal) so `tsc` never tries to resolve the module's types
 * for a consumer that doesn't have the opt-in package installed.
 */
type CreateApolloProvider = (cfg: { apiKey: string }) => EnrichmentProvider;

const APOLLO_PACKAGE = ["@hogsend", "plugin-apollo"].join("/");

/**
 * The guard around the dynamic import, extracted so it is testable against an
 * INJECTED unresolvable specifier (never against `@hogsend/plugin-apollo`
 * genuinely being absent — once that package lands in `optionalDependencies`,
 * an absence-based test would silently assert the opposite of what it means).
 *
 * Resolves to the named factory export, or null when the package cannot be
 * resolved / the export is missing — in which case `onMissing` fires (once,
 * since the module-scope call site runs once per process) and nothing throws:
 * a key set without the plugin installed degrades gracefully, and if the
 * provider was EXPLICITLY requested the container still throws its clear
 * "not registered" boot error.
 */
export async function loadEnrichmentPluginFactory<T>(opts: {
  specifier: string;
  exportName: string;
  onMissing?: (message: string) => void;
}): Promise<T | null> {
  try {
    const mod = (await import(opts.specifier)) as Record<string, unknown>;
    const factory = mod[opts.exportName];
    if (typeof factory !== "function") {
      throw new Error(`missing export "${opts.exportName}"`);
    }
    return factory as T;
  } catch {
    opts.onMissing?.(
      `enrichment plugin "${opts.specifier}" is not installed — its env preset is skipped. ` +
        `Install the package (pnpm add ${opts.specifier}) to enable it.`,
    );
    return null;
  }
}

let createApolloProvider: CreateApolloProvider | null = null;
if (process.env.APOLLO_API_KEY) {
  createApolloProvider =
    await loadEnrichmentPluginFactory<CreateApolloProvider>({
      specifier: APOLLO_PACKAGE,
      exportName: "createApolloProvider",
      // Module scope ⇒ logs ONCE per process, and only when the key is set.
      onMissing: (message) => console.warn(message),
    });
}

/**
 * Build the env-enabled enrichment-provider presets. A preset is constructed
 * ONLY when its credential is present AND the opt-in package resolved (see the
 * guarded dynamic import above), so a deploy without an Apollo key never
 * touches the package and contributes no provider.
 *
 * These presets come FIRST in the container's merge — a consumer-supplied
 * provider of the same id wins (last-writer-wins on the registry).
 */
export function enrichmentProvidersFromEnv(
  env: typeof envSchema,
): EnrichmentProvider[] {
  const providers: EnrichmentProvider[] = [];

  if (env.APOLLO_API_KEY && createApolloProvider) {
    providers.push(createApolloProvider({ apiKey: env.APOLLO_API_KEY }));
  }

  return providers;
}
