import type { EnrichmentProvider } from "@hogsend/core";
import type { env as envSchema } from "../env.js";
import { loadOptionalPlugin } from "./load-optional-plugin.js";

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

let createApolloProvider: CreateApolloProvider | null = null;
if (process.env.APOLLO_API_KEY) {
  createApolloProvider = await loadOptionalPlugin<CreateApolloProvider>({
    specifier: APOLLO_PACKAGE,
    exportName: "createApolloProvider",
    enabledBy: "APOLLO_API_KEY is set",
    // Module scope ⇒ logs ONCE per process, and only when the key is set.
    onFailure: (message) => console.warn(message),
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
