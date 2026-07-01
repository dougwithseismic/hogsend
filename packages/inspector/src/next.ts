import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * withInspector — the build-time half of the Hogsend inspector.
 *
 * Wrap your Next config with this and, IN DEV ONLY, matching JSX elements are
 * stamped with `data-hs-source="file:line:col"` (via the Turbopack loader). That
 * attribute is what lets the runtime overlay map a clicked element back to its
 * exact source location — to open it in the editor or edit its text in place.
 *
 * In production it is a no-op: the loader rule is never added, so no source
 * paths are stamped into shipped HTML and there is zero cost.
 *
 *   // next.config.mjs
 *   import { withInspector } from "@hogsend/inspector/next";
 *   export default withInspector(nextConfig, { include: ["/components/"] });
 */

export type WithInspectorOptions = {
  /**
   * Path fragments deciding which files get stamped. A file is stamped only if
   * its absolute path contains one of these. Default: ["/components/"].
   */
  include?: string[];
  /**
   * Absolute path that stamped paths are made relative to. Default: the app's
   * cwd (where `next dev` runs) — so stamps read like `components/hero.tsx:3:5`.
   */
  root?: string;
};

// biome-ignore lint/suspicious/noExplicitAny: Next's config type isn't a dep here.
type NextConfig = Record<string, any>;

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/next.js → package root → loader/stamp-loader.cjs (shipped raw).
const loaderPath = path.join(here, "..", "loader", "stamp-loader.cjs");

export function withInspector(
  nextConfig: NextConfig = {},
  options: WithInspectorOptions = {},
): NextConfig {
  if (process.env.NODE_ENV === "production") return nextConfig;

  const loaderOptions = {
    root: options.root ?? process.cwd(),
    include: options.include ?? ["/components/"],
  };

  return {
    ...nextConfig,
    turbopack: {
      ...(nextConfig.turbopack ?? {}),
      rules: {
        ...(nextConfig.turbopack?.rules ?? {}),
        // Glob is broad (Turbopack matches these reliably); the loader narrows
        // to `include` and passes everything else through untouched, so
        // non-matching modules keep the bundler's native fast path.
        "*.tsx": {
          loaders: [{ loader: loaderPath, options: loaderOptions }],
        },
      },
    },
  };
}
