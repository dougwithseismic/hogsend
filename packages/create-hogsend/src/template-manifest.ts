/**
 * The engine version line that `create-hogsend` pins into the emitted
 * `package.json`. This is the SINGLE source of truth for the pin — bumped on
 * each release to track the `@hogsend/engine` package `version`.
 *
 * MUST equal the `@hogsend/engine` package version. This is NOT related to
 * `API_VERSION` in `packages/engine/src/env.ts` (the HTTP API contract version),
 * which moves on its own cadence.
 *
 * The emitted template uses engine exports (e.g. `reportApiReady` in
 * `template/src/index.ts`); publishing `create-hogsend` without bumping this to
 * an engine version that actually exports them yields a scaffold that won't
 * compile. Bump in lockstep — see the `release` skill.
 *
 * 0.24.0 adds `ctx.history.events()` and the webhook-route `process.env`
 * secret-resolution fix, and the scaffold ships the Tier-1 AI onboarding
 * journey (Vercel AI SDK). Published to npm.
 */
export const ENGINE_VERSION = "0.35.1";

/** Every `@hogsend/*` package the scaffolded app depends on. */
export const HOGSEND_PACKAGES = [
  "cli",
  "client",
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
  // Starter email templates that reference the app name in their copy.
  "magic-link.tsx",
  "onboarding-personalized.tsx",
  // The Tier-1 AI agent prompt is personalised with the app name.
  "onboarding-concierge.ts",
  // Matched on the RENAMED basename (CLAUDE.template.md -> CLAUDE.md), so the
  // {{APP_NAME}}/{{ENGINE_VERSION}} tokens in the orientation file resolve.
  "CLAUDE.md",
] as const;
