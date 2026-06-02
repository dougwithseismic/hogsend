import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend studio [options]

Serve the bundled Hogsend Studio (the admin SPA) locally and open it in a
browser. The Studio is a static single-page app; this command starts a tiny
local web server for it on a port of your choosing.

By default the Studio talks to the API at the same origin it is served from,
which won't be a running API here — so point it at your instance with
--base-url (the SPA uses cookie auth, so the instance must allow CORS from the
Studio origin, or you can simply open the Studio that the engine mounts at
\`<instance>/studio\` instead).

Options:
  --port <n>          Local port to serve on (default 3333).
  --base-url <url>    API instance the Studio should call (injected at runtime).
                      Omit to use same-origin (the local server, for static
                      preview only).
  --open              Open the Studio in your default browser after starting.
  --dist <path>       Override the Studio dist directory (advanced).
  -h, --help          Show this help.

Examples:
  hogsend studio --open
  hogsend studio --base-url https://api.example.com --open
  hogsend studio --port 4000`;

/**
 * Resolve the built Studio `dist/` directory.
 *
 * Resolution order:
 *  1. Explicit --dist override (positional path; absolute or cwd-relative).
 *  2. The dist bundled inside this CLI package (shipped via package.json files[];
 *     at runtime bin.js is <pkg>/dist/bin.js, so the bundled studio is one level
 *     up at <pkg>/studio).
 *  3. Monorepo source layout: packages/studio/dist relative to this file.
 *  4. cwd-relative packages/studio/dist (running from repo root).
 */
function resolveStudioDist(distFlag: string | undefined): string | null {
  const candidates: string[] = [];

  if (distFlag && distFlag.length > 0) {
    candidates.push(resolve(process.cwd(), distFlag));
  }

  // Bundled in the published CLI tarball at <pkg>/studio.
  candidates.push(fileURLToPath(new URL("../studio", import.meta.url)));

  // Monorepo: this file is packages/cli/src/commands/studio.ts (or built into
  // dist/), so the studio dist sits at ../../studio/dist relative to dist/.
  candidates.push(
    fileURLToPath(new URL("../../studio/dist", import.meta.url)),
    fileURLToPath(new URL("../../../studio/dist", import.meta.url)),
  );

  candidates.push(resolve(process.cwd(), "packages/studio/dist"));

  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Read index.html and, when a base URL is provided, inject a runtime global the
 * Studio reads (`window.__HOGSEND_STUDIO__ = { baseUrl }`) so the static bundle
 * can be pointed at a remote instance without a rebuild.
 */
function indexHtml(distPath: string, baseUrl: string | undefined): string {
  const raw = readFileSync(join(distPath, "index.html"), "utf8");
  if (!baseUrl) return raw;
  const inject = `<script>window.__HOGSEND_STUDIO__=${JSON.stringify({
    baseUrl,
  })};</script>`;
  if (raw.includes("</head>")) {
    return raw.replace("</head>", `${inject}</head>`);
  }
  return `${inject}${raw}`;
}

/** Open a URL in the OS default browser (best-effort, never throws). */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort
  }
}

async function run(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string" },
      "base-url": { type: "string" },
      open: { type: "boolean", default: false },
      dist: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const port = Number(values.port ?? "3333");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.out.fail(`invalid --port "${values.port}" (expected 1-65535)`);
  }

  // --base-url flag, else the resolved CLI config base URL (so it "just works"
  // against the same instance the other commands target), unless that's the
  // local default placeholder. Keep undefined for pure static preview.
  const baseUrl =
    typeof values["base-url"] === "string" ? values["base-url"] : undefined;

  const distPath = resolveStudioDist(
    typeof values.dist === "string" ? values.dist : positionals[0],
  );

  if (!distPath) {
    ctx.out.fail(
      "could not find a built Studio (dist/). Build it with " +
        "`pnpm --filter @hogsend/studio build`, or pass --dist <path>.",
    );
  }

  const cleanBase = baseUrl ? baseUrl.replace(/\/+$/, "") : undefined;
  const index = indexHtml(distPath, cleanBase);

  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");

    // The Studio bundle is built under base "/studio/", so all asset URLs are
    // prefixed with /studio. Strip that prefix to map onto the dist root.
    const rel = urlPath.replace(/^\/studio/, "");
    if (rel === "" || rel === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(index);
      return;
    }

    // Resolve safely inside distPath (defend against path traversal).
    const target = normalize(join(distPath, rel));
    if (target !== distPath && !target.startsWith(distPath + sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (existsSync(target) && statSync(target).isFile()) {
      res.writeHead(200, { "content-type": mimeFor(target) });
      createReadStream(target).pipe(res);
      return;
    }

    // SPA fallback: unknown paths serve index.html so client-side routes work.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(index);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolveListen());
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.out.fail(`could not start server on port ${port}: ${msg}`);
  });

  const localUrl = `http://localhost:${port}/studio/`;

  if (ctx.json) {
    ctx.out.json({
      url: localUrl,
      port,
      baseUrl: cleanBase ?? null,
      dist: distPath,
    });
    // In json mode we still keep the server running (foreground). Agents that
    // don't want a long-running process should not pass --json to `studio`.
  } else {
    ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} studio`);
    ctx.out.note(
      [
        `${color.green("●")} Studio serving at ${color.cyan(localUrl)}`,
        cleanBase
          ? color.dim(`API instance: ${cleanBase}`)
          : color.dim(
              "No --base-url set (same-origin / static preview). The API " +
                "calls will hit this local server and fail — pass --base-url " +
                "<instance>, or open <instance>/studio directly.",
            ),
        "",
        color.dim("First load shows a create-admin screen if no admin exists."),
        color.dim("Press Ctrl+C to stop."),
      ].join("\n"),
      "Studio",
    );
  }

  if (values.open) {
    openBrowser(localUrl);
  }

  // Keep the process alive until interrupted.
  await new Promise<void>((resolveForever) => {
    const stop = () => {
      server.close(() => resolveForever());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export const studioCommand: Command = {
  name: "studio",
  summary: "Serve the bundled Hogsend Studio admin SPA locally",
  usage,
  run,
};
