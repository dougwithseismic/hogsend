/**
 * Shared loader for the engine's OPT-IN plugin packages (`@hogsend/plugin-apollo`,
 * `-postmark`, `-twilio`). Each is an engine `optionalDependency`, never a hard
 * one: a static import would make the package mandatory at engine load and break
 * `npm install @hogsend/engine` for every consumer without it.
 *
 * So each preset loads its package lazily, ONCE, behind a guarded dynamic import
 * gated on the relevant credential. The specifier is assembled at runtime (not a
 * literal) so `tsc` never resolves the module's types for a consumer that does
 * not have the opt-in package.
 *
 * ## Why the failure message matters so much
 *
 * All three presets previously swallowed the failure — SMS silently, enrichment
 * behind a message that said "is not installed" for EVERY failure mode. That
 * message was actively wrong in the most common real case (installed, but the
 * package shipped raw `.ts` that Node cannot type-strip inside node_modules), so
 * an operator following it reinstalled a package they already had. The whole
 * point of this module is that the two failure modes are DIFFERENT problems with
 * different fixes, and conflating them sends people to fix the wrong thing.
 *
 * `not-installed` is a configuration problem the operator can fix.
 * `load-failed` is OUR bug and should be reported, not worked around.
 */

import { recordBootDiagnostic } from "./boot-diagnostics.js";

export type PluginLoadOutcome =
  | "not-installed"
  | "load-failed"
  | "missing-export";

/**
 * Distinguish "the package itself is absent" from "the package is present but
 * blew up while loading".
 *
 * Both surface as `ERR_MODULE_NOT_FOUND` in the general case — a plugin whose
 * own npm dependency is missing throws exactly the same code. So a bare code
 * check would mislabel "plugin-twilio is installed but `twilio` isn't" as
 * "plugin-twilio is not installed" and send the operator to reinstall the wrong
 * package. Requiring the message to name the specifier keeps the two apart.
 */
function classify(error: unknown, specifier: string): PluginLoadOutcome {
  const err = error as { code?: string; message?: string } | undefined;
  const notFound =
    err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND";
  return notFound && (err?.message ?? "").includes(specifier)
    ? "not-installed"
    : "load-failed";
}

function describe(error: unknown): string {
  const err = error as { code?: string; message?: string } | undefined;
  const code = err?.code ? `${err.code}: ` : "";
  return `${code}${(err?.message ?? String(error)).split("\n")[0]}`;
}

function messageFor(opts: {
  specifier: string;
  exportName: string;
  enabledBy: string;
  outcome: PluginLoadOutcome;
  error?: unknown;
}): string {
  const { specifier, exportName, enabledBy, outcome, error } = opts;
  const skipped = `${enabledBy}, but its env preset is skipped`;

  if (outcome === "not-installed") {
    return (
      `${skipped}: "${specifier}" is not installed. ` +
      `Add it as a DIRECT dependency of your app: pnpm add ${specifier}. ` +
      `Note that the engine listing it under optionalDependencies is NOT enough — ` +
      `your app bundles the engine, so this import resolves against YOUR ` +
      `node_modules, where an engine-only optional dependency is never linked.`
    );
  }

  if (outcome === "missing-export") {
    return (
      `${skipped}: "${specifier}" loaded but does not export "${exportName}". ` +
      `This usually means the package version does not match @hogsend/engine — ` +
      `align them on the same engine line (pnpm add ${specifier}@<engine version>).`
    );
  }

  return (
    `${skipped}: "${specifier}" IS installed but failed to load — ` +
    `${describe(error)}. This is a packaging bug in Hogsend rather than ` +
    `anything wrong with your configuration; please report it. ` +
    `Reinstalling the package will not help.`
  );
}

/**
 * Resolve a named factory export from an optional plugin package.
 *
 * Returns the factory, or `null` when the package cannot be loaded — in which
 * case `onFailure` fires (once, since every call site runs at module scope, once
 * per process) and NOTHING throws. A credential set without a working plugin
 * degrades gracefully; if the provider was EXPLICITLY selected the container
 * still throws its own clear "not registered" error at boot.
 *
 * Deliberately testable against an INJECTED specifier so the guard can be
 * exercised without depending on a real package being absent — once these
 * packages are engine optionalDependencies, an absence-based test would silently
 * assert the opposite of what it means.
 */
export async function loadOptionalPlugin<T>(opts: {
  specifier: string;
  exportName: string;
  /** What switched this on, e.g. `"APOLLO_API_KEY is set"`. Named in the message. */
  enabledBy: string;
  onFailure?: (message: string, outcome: PluginLoadOutcome) => void;
}): Promise<T | null> {
  const { specifier, exportName, enabledBy, onFailure } = opts;

  // Every failure path records a boot diagnostic HERE, unconditionally — not
  // in the call sites' `onFailure` hooks. The hooks run once per process at
  // module scope, gated on env at import time, so hook-side recording could
  // never be exercised in-workspace (the real plugins are workspace-linked);
  // this loader is the one seam an injected specifier can drive through all
  // three outcomes. The code bakes in outcome + specifier so two broken
  // plugins (or two outcomes) yield two entries, never a silent dedupe.
  const fail = (outcome: PluginLoadOutcome, error?: unknown): null => {
    const message = messageFor({
      specifier,
      exportName,
      enabledBy,
      outcome,
      error,
    });
    recordBootDiagnostic({ code: `plugin.${outcome}:${specifier}`, message });
    onFailure?.(message, outcome);
    return null;
  };

  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return fail(classify(error, specifier), error);
  }

  const factory = mod[exportName];
  if (typeof factory !== "function") return fail("missing-export");

  return factory as T;
}
