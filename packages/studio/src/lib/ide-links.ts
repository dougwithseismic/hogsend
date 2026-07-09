/**
 * "Open source" links for journey flow nodes.
 *
 * A flow node carries a `sourceFile` (relative to the project root, e.g.
 * `src/journeys/churn-prevention.ts`) and a `sourceLine`. There are two ways to
 * jump to that source, and they trade off differently:
 *
 *   1. REPO link (default, easiest) — a GitHub/GitLab "blob" URL like
 *      `https://github.com/org/repo/blob/main/src/journeys/x.ts#L42`. One
 *      setting (the blob base) covers every file, it works on any machine
 *      (incl. a hosted Studio), it's shareable, and it never dead-clicks the
 *      way a `vscode://` link does when the editor isn't installed.
 *
 *   2. IDE deep link (power users) — `vscode://file/{abs}:{line}` and friends.
 *      Opens the local editor instantly, but needs the ABSOLUTE path on THIS
 *      machine, which the server must never supply. So the project root is a
 *      client-only setting.
 *
 * Everything is stored in localStorage; nothing is sent to the server.
 * (Web research: GitHub blob links are the recommended primary, IDE deep links
 * the fallback — see the module the dialog links to.)
 */

const MODE_KEY = "hogsend.studio.src.mode";
const REPO_KEY = "hogsend.studio.src.repo";
const TEMPLATE_KEY = "hogsend.studio.ide.template";
const ROOT_KEY = "hogsend.studio.ide.projectRoot";

export type OpenMode = "repo" | "ide";

export interface IdePreset {
  id: string;
  label: string;
  /** URL template. Placeholders: {path} (abs), {line}, {relPath}, {root}. */
  template: string;
}

/**
 * Built-in editor schemes. `{path}` is the absolute file path (already starts
 * with `/` on POSIX, so `vscode://file{path}` yields `vscode://file/Users/…`).
 */
export const IDE_PRESETS: IdePreset[] = [
  { id: "vscode", label: "VS Code", template: "vscode://file{path}:{line}" },
  { id: "cursor", label: "Cursor", template: "cursor://file{path}:{line}" },
  {
    id: "windsurf",
    label: "Windsurf",
    template: "windsurf://file{path}:{line}",
  },
  { id: "zed", label: "Zed", template: "zed://file{path}:{line}" },
  {
    id: "jetbrains",
    label: "JetBrains",
    template: "idea://open?file={path}&line={line}",
  },
];

export const DEFAULT_IDE_TEMPLATE = "vscode://file{path}:{line}";

export interface SourceLinkConfig {
  mode: OpenMode;
  /** Blob base for repo mode, e.g. `https://github.com/org/repo/blob/main`. */
  repoBaseUrl: string;
  /** IDE URL template (ide mode). */
  template: string;
  /** Absolute local checkout root (ide mode). */
  projectRoot: string;
}

/** Read the persisted config (localStorage), defaulting to the easy repo mode. */
export function getSourceLinkConfig(): SourceLinkConfig {
  if (typeof localStorage === "undefined") {
    return {
      mode: "repo",
      repoBaseUrl: "",
      template: DEFAULT_IDE_TEMPLATE,
      projectRoot: "",
    };
  }
  const mode = localStorage.getItem(MODE_KEY);
  return {
    mode: mode === "ide" ? "ide" : "repo",
    repoBaseUrl: localStorage.getItem(REPO_KEY) ?? "",
    template: localStorage.getItem(TEMPLATE_KEY) ?? DEFAULT_IDE_TEMPLATE,
    projectRoot: localStorage.getItem(ROOT_KEY) ?? "",
  };
}

/** Persist a partial config update. */
export function setSourceLinkConfig(patch: Partial<SourceLinkConfig>): void {
  if (typeof localStorage === "undefined") return;
  if (patch.mode !== undefined) localStorage.setItem(MODE_KEY, patch.mode);
  if (patch.repoBaseUrl !== undefined) {
    localStorage.setItem(REPO_KEY, patch.repoBaseUrl.trim());
  }
  if (patch.template !== undefined) {
    localStorage.setItem(TEMPLATE_KEY, patch.template);
  }
  if (patch.projectRoot !== undefined) {
    localStorage.setItem(ROOT_KEY, patch.projectRoot.trim());
  }
}

/** Join a project root and a relative file into a clean absolute path. */
function joinPath(root: string, relPath: string): string {
  const cleanRoot = root.replace(/[/\\]+$/, "");
  const cleanRel = relPath.replace(/^[/\\]+/, "");
  return `${cleanRoot}/${cleanRel}`;
}

export interface SourceLink {
  url: string;
  /** Short verb for the button, e.g. "Open on GitHub" / "Open in IDE". */
  label: string;
  /** True when it opens in the browser (safe anchor); false for OS schemes. */
  web: boolean;
}

/**
 * Build the "open source" link for a node's source pointer, honoring the
 * active mode. Returns null when the needed setting is missing (the caller
 * then prompts the user to configure it, or falls back to copying).
 */
export function buildSourceLink(args: {
  sourceFile: string;
  line?: number;
  config?: SourceLinkConfig;
}): SourceLink | null {
  const config = args.config ?? getSourceLinkConfig();
  const relPath = args.sourceFile.replace(/^[/\\]+/, "");
  const line = args.line ?? 1;

  if (config.mode === "repo") {
    if (!config.repoBaseUrl) return null;
    const base = config.repoBaseUrl.replace(/\/+$/, "");
    // GitHub/GitLab both anchor a line as `#L<n>`.
    const host = /gitlab/i.test(base) ? "GitLab" : "GitHub";
    return {
      url: `${base}/${relPath}#L${line}`,
      label: `Open on ${host}`,
      web: true,
    };
  }

  if (!config.projectRoot) return null;
  const abs = joinPath(config.projectRoot, relPath);
  const url = config.template
    .replaceAll("{path}", abs)
    .replaceAll("{relPath}", relPath)
    .replaceAll("{root}", config.projectRoot.replace(/[/\\]+$/, ""))
    .replaceAll("{line}", String(line));
  return { url, label: "Open in IDE", web: false };
}
