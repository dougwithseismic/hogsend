import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import { createLogger } from "../../lib/logger.js";

/**
 * Dev-only "open in editor" endpoint. The Studio SPA can't spawn a process, so
 * it POSTs a source path here and the engine — running on the SAME machine as
 * the developer in local dev — opens it in whatever editor they use.
 *
 * Editor AUTO-DETECTION is delegated to `launch-editor` (the mechanism behind
 * Vite/CRA error overlays): it honours `$LAUNCH_EDITOR`/`$VISUAL`/`$EDITOR`,
 * else scans running processes for a known editor (Cursor, VS Code, Windsurf,
 * WebStorm, …). So there is no editor picker — it just opens "your editor".
 *
 * Safety envelope (this spawns a process on the host):
 *  - DEV ONLY: hard 404 when NODE_ENV=production.
 *  - Admin-authed: mounted under the admin router (requireAdmin).
 *  - Path allowlist: absolute path, a known source extension, and it must exist.
 *  - `launch-editor` spawns argv (never a shell string), so a crafted path can't
 *    inject a command.
 */

const require = createRequire(import.meta.url);

// launch-editor is CommonJS and ships no types. Signature:
// launch(file, [specifiedEditor], [onErrorCallback]) — no editor => auto-guess.
type LaunchEditor = (
  file: string,
  editor?: string,
  onError?: (fileName: string, errorMsg: string) => void,
) => void;

// Loaded LAZILY, only on the dev-only code path below, so a production build
// never `require`s it — keeps launch-editor out of the prod dependency graph
// (and away from the CJS-in-ESM bundling gotcha for npm consumers).
let launchEditor: LaunchEditor | undefined;
function getLaunchEditor(): LaunchEditor {
  if (!launchEditor) {
    launchEditor = require("launch-editor") as LaunchEditor;
  }
  return launchEditor;
}

const logger = createLogger(process.env.LOG_LEVEL);

const bodySchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
});

/** Source files the Studio can deep-link (journeys + email templates + kin). */
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

/**
 * Editor to spawn when none is running and no `$HS_EDITOR`/`$VISUAL`/`$EDITOR`
 * is set. `cursor`/`code`/`windsurf` all accept the `file:line` target.
 */
const DEFAULT_EDITOR = "cursor";

export const openEditorRouter = new OpenAPIHono<AppEnv>().post(
  "/",
  async (c) => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "not available" }, 404);
    }

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const { path, line } = body;
    if (!path.startsWith("/") || !SOURCE_EXT.test(path)) {
      return c.json({ error: "path not allowed" }, 403);
    }
    if (!existsSync(path)) {
      return c.json({ error: "file not found" }, 404);
    }

    const target = line ? `${path}:${line}` : path;
    const launch = getLaunchEditor();
    const onErr = (fileName: string, errorMsg: string) => {
      logger.warn(`open-in-editor failed for ${fileName}: ${errorMsg}`);
    };

    // `launch-editor` auto-detects a RUNNING editor (or $VISUAL/$EDITOR), but
    // launches nothing when the editor is closed and no env var is set. So:
    //   1. `HS_EDITOR` (explicit override) → spawn it directly, open or not.
    //   2. else auto-detect a running editor.
    //   3. if that finds nothing, fall back to a default editor and spawn it —
    //      this is what makes "open in IDE" work even when it isn't running yet.
    const forced = process.env.HS_EDITOR?.trim();
    if (forced) {
      launch(target, forced, onErr);
    } else {
      launch(target, undefined, () => launch(target, DEFAULT_EDITOR, onErr));
    }

    return c.json({ ok: true, target }, 200);
  },
);
