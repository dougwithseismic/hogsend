import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

/**
 * Build a mermaid.live editor deep link for a diagram. The editor's URL hash
 * format is `#pako:<base64url(zlib-deflate(JSON state))>` — the same encoding
 * the editor itself produces via pako (zlib container, so Node's `deflateSync`
 * is byte-compatible).
 */
export function mermaidLiveUrl(code: string): string {
  const state = JSON.stringify({
    code,
    mermaid: JSON.stringify({ theme: "dark" }),
    autoSync: true,
    updateDiagram: true,
  });
  const compressed = deflateSync(Buffer.from(state, "utf8"), { level: 9 });
  return `https://mermaid.live/edit#pako:${compressed.toString("base64url")}`;
}

/**
 * Best-effort open of a URL in the platform browser. Returns false when the
 * opener is unavailable (headless CI) — callers should still print the URL.
 */
export function openInBrowser(url: string): boolean {
  const isWin = process.platform === "win32";
  const cmd =
    process.platform === "darwin" ? "open" : isWin ? "start" : "xdg-open";
  try {
    const res = spawnSync(cmd, [url], {
      stdio: "ignore",
      shell: isWin,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}
