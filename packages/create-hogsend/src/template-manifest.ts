/**
 * The engine version line that `create-hogsend` pins into the emitted
 * `package.json`. This is the SINGLE source of truth for the pin — Phase 4
 * changesets bumps it in lockstep with `packages/engine/package.json`
 * (`version`) and `packages/engine/src/env.ts` (`API_VERSION`).
 *
 * MUST equal the `@hogsend/engine` package version.
 */
export const ENGINE_VERSION = "0.4.0";

/** Every `@hogsend/*` package the scaffolded app depends on. */
export const HOGSEND_PACKAGES = [
  "core",
  "db",
  "email",
  "engine",
  "plugin-posthog",
  "plugin-resend",
  "studio",
] as const;

/**
 * Files renamed on emit. Source files in `template/` carry "safe" names so the
 * monorepo's own tooling (pnpm workspaces, npm pack, Biome) does not pick them
 * up, and so the leading-underscore `_package.json` is not treated as a nested
 * workspace. The CLI renames them back when writing the scaffolded app.
 */
export const RENAME_MAP: Record<string, string> = {
  gitignore: ".gitignore",
  npmrc: ".npmrc",
  "env.example": ".env.example",
  "node-version": ".node-version",
  "_package.json": "package.json",
  // The scaffolded app's always-loaded agent orientation. Authored as
  // CLAUDE.template.md so the monorepo's own tooling never treats it as guidance
  // for THIS repo; renamed to CLAUDE.md (and token-substituted) on emit.
  "CLAUDE.template.md": "CLAUDE.md",
};

/**
 * Token-substituted files (literal `{{APP_NAME}}` / `{{ENGINE_VERSION}}`).
 * Matched by basename. The starter email files carry `{{APP_NAME}}` so the
 * scaffolded welcome copy reads with the user's app name out of the box; files
 * without tokens are unaffected by the substitution.
 */
export const TOKEN_FILES = [
  "package.json",
  "README.md",
  "footer.tsx",
  "welcome.tsx",
  "logo.tsx",
  "registry.ts",
  // Matched on the RENAMED basename (CLAUDE.template.md -> CLAUDE.md), so the
  // {{APP_NAME}}/{{ENGINE_VERSION}} tokens in the orientation file resolve.
  "CLAUDE.md",
] as const;
