"use client";

import {
  Braces,
  ChevronDown,
  FileCode2,
  Mail,
  QrCode,
  Settings2,
  Webhook,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { EmailPane } from "./email-preview";
import type { EmailPreview } from "./minted-files";

/* ==========================================================================
 *  The scaffold explorer — an IDE-shaped window that walks the app
 *  `create-hogsend` writes. File tree on the left (journeys, emails, webhook
 *  sources, the worker), the clicked file's highlighted source on the right,
 *  and — when the file is an email template — the rendered message floating
 *  in a corner preview window, the same way the hero mints email windows.
 *
 *  Highlighting happens server-side (Shiki via `CodeHighlight`); this client
 *  component receives the rendered nodes keyed by path, so there is zero
 *  highlighting JS shipped.
 * ========================================================================== */

export type ExplorerFile = {
  path: string;
  email?: EmailPreview;
  timing?: boolean;
};

export type ExplorerRecipe = { label: string; path: string };

/** Compact schedule readout for `ctx.when` files — the local send time is
 *  pinned per reader while the UTC instant moves. July offsets, real math. */
function TimingPane() {
  const rows = [
    { city: "San Francisco", zone: "PDT", utc: "16:00 UTC" },
    { city: "Berlin", zone: "CEST", utc: "07:00 UTC" },
    { city: "Tokyo", zone: "JST", utc: "00:00 UTC" },
  ];
  return (
    <div className="px-4 py-3">
      <p className="font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
        ctx.when.next("tuesday").at("09:00")
      </p>
      <ul className="mt-2.5 space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.city}
            className="flex items-baseline justify-between gap-3 text-[12px]"
          >
            <span className="text-white/70">{r.city}</span>
            <span className="font-mono text-[11px] text-white/85">
              Tue 09:00 <span className="text-white/35">{r.zone}</span>
            </span>
            <span className="font-mono text-[10.5px] text-white/30">
              {r.utc}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-white/[0.07] border-t pt-2.5 text-[11px] text-white/40 leading-[1.5]">
        The local time never moves — the UTC instant does. Resolved per user,
        slept to durably.
      </p>
    </div>
  );
}

type TreeNode = {
  name: string;
  path?: string;
  children?: TreeNode[];
};

function buildTree(files: ExplorerFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const segments = file.path.split("/");
    let level = root;
    segments.forEach((segment, i) => {
      const leaf = i === segments.length - 1;
      let node = level.find((n) => n.name === segment);
      if (!node) {
        node = leaf
          ? { name: segment, path: file.path }
          : { name: segment, children: [] };
        level.push(node);
      }
      if (!leaf && node.children) level = node.children;
    });
  }
  return root;
}

function leafCount(node: TreeNode): number {
  if (!node.children) return 1;
  return node.children.reduce((n, c) => n + leafCount(c), 0);
}

function fileIcon(path: string) {
  if (path.includes("/emails/")) return Mail;
  if (path.includes("/webhook-sources/")) return Webhook;
  if (path.endsWith(".sh")) return QrCode;
  if (path.endsWith(".env")) return Settings2;
  if (path.includes("/journeys/")) return Braces;
  return FileCode2;
}

function FileRow({
  node,
  depth,
  parentPath,
  active,
  onSelect,
  collapsed,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  parentPath: string;
  active: string;
  onSelect: (path: string) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (folderPath: string) => void;
}) {
  if (node.children) {
    const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const isCollapsed = collapsed.has(folderPath);
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(folderPath)}
          className="flex w-full cursor-pointer items-center gap-1.5 py-[3.5px] text-left font-mono text-[11.5px] text-white/45 transition-colors hover:text-white/75"
          style={{ paddingLeft: 10 + depth * 11 }}
        >
          <ChevronDown
            size={11}
            className={cn(
              "shrink-0 text-white/25 transition-transform",
              isCollapsed && "-rotate-90",
            )}
          />
          {node.name}
          {isCollapsed ? (
            <span className="ml-1 text-[9.5px] text-white/25">
              {leafCount(node)}
            </span>
          ) : null}
        </button>
        {isCollapsed
          ? null
          : node.children.map((child) => (
              <FileRow
                key={child.name}
                node={child}
                depth={depth + 1}
                parentPath={folderPath}
                active={active}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ))}
      </div>
    );
  }

  const path = node.path ?? node.name;
  const Icon = fileIcon(path);
  const isActive = active === path;
  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 py-[3.5px] text-left font-mono text-[11.5px] transition-colors",
        isActive
          ? "bg-[#f64838]/[0.12] text-white"
          : "text-white/55 hover:bg-white/[0.04] hover:text-white/85",
      )}
      style={{ paddingLeft: 10 + depth * 11 + 15 }}
    >
      <Icon
        size={12}
        className={cn(
          "shrink-0",
          isActive ? "text-[#f64838]" : "text-white/30",
        )}
      />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function ScaffoldExplorer({
  files,
  highlighted,
  recipes,
}: {
  files: ExplorerFile[];
  highlighted: Record<string, ReactNode>;
  /** Quick-select chips over the editor — each names a recipe and opens its file. */
  recipes?: ExplorerRecipe[];
}) {
  const [active, setActive] = useState(files[0]?.path ?? "");
  // The email templates start folded so the tree reads at a glance;
  // the count chip invites the click.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(["hogsend/src/emails"]),
  );
  const tree = useMemo(() => buildTree(files), [files]);
  const activeFile = files.find((f) => f.path === active);

  const toggleFolder = (folderPath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });

  // Selecting a file (tree row, chip, or recipe) also expands its ancestor
  // folders so the tree always shows where you are.
  const openFile = (path: string) => {
    setActive(path);
    setCollapsed((prev) => {
      const next = new Set(prev);
      const segments = path.split("/");
      let folder = "";
      for (const segment of segments.slice(0, -1)) {
        folder = folder ? `${folder}/${segment}` : segment;
        next.delete(folder);
      }
      return next;
    });
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.09] bg-[#0d0d11] shadow-2xl">
      {/* window chrome */}
      <div className="flex items-center gap-3 border-white/[0.07] border-b px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/[0.12]" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/[0.12]" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/[0.12]" />
        </div>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-[11px] text-white/40">
          my-app — <span className="text-white/60">hogsend/</span> written by
          create-hogsend · <span className="text-white/60">web/</span> is your
          product
        </span>
        <span className="hidden font-mono text-[10px] text-white/25 sm:block">
          click a file
        </span>
      </div>

      <div className="flex">
        {/* file tree — collapses to a chip row on small screens */}
        <aside className="hidden max-h-[560px] w-[240px] shrink-0 overflow-y-auto border-white/[0.07] border-r py-3 [scrollbar-width:thin] md:block">
          <div className="px-3 pb-2 font-mono text-[10px] text-white/30 uppercase tracking-[0.08em]">
            my-app
          </div>
          {tree.map((node) => (
            <FileRow
              key={node.name}
              node={node}
              depth={0}
              parentPath=""
              active={active}
              onSelect={openFile}
              collapsed={collapsed}
              onToggle={toggleFolder}
            />
          ))}
        </aside>

        <div className="min-w-0 flex-1">
          <div className="flex gap-1.5 overflow-x-auto border-white/[0.07] border-b px-3 py-2 [scrollbar-width:none] md:hidden">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => openFile(f.path)}
                className={cn(
                  "shrink-0 cursor-pointer rounded-full border px-3 py-1 font-mono text-[10.5px] transition-colors",
                  active === f.path
                    ? "border-[#f64838]/40 bg-[#f64838]/[0.12] text-white"
                    : "border-white/[0.08] text-white/50",
                )}
              >
                {f.path.split("/").pop()}
              </button>
            ))}
          </div>

          {/* recipe quick-select — the old "pick a use case" section, merged */}
          {recipes?.length ? (
            <div className="hidden flex-wrap gap-1.5 border-white/[0.07] border-b px-3 py-2.5 md:flex">
              {recipes.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => openFile(r.path)}
                  className={cn(
                    "shrink-0 cursor-pointer rounded-full border px-3 py-1 font-mono text-[10.5px] transition-colors",
                    active === r.path
                      ? "border-[#f64838]/40 bg-[#f64838]/[0.12] text-white"
                      : "border-white/[0.08] text-white/50 hover:border-white/20 hover:text-white/80",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* editor pane */}
          <div className="relative">
            <div className="flex items-center justify-between border-white/[0.07] border-b px-4 py-2">
              <span className="truncate font-mono text-[11px] text-white/45">
                {active}
              </span>
              {activeFile?.email ? (
                <span className="shrink-0 font-mono text-[10px] text-[#f64838]/80 uppercase tracking-[0.06em]">
                  renders → preview
                </span>
              ) : activeFile?.timing ? (
                <span className="shrink-0 font-mono text-[10px] text-[#f64838]/80 uppercase tracking-[0.06em]">
                  resolves → schedule
                </span>
              ) : null}
            </div>

            <div
              key={active}
              className="ps-code h-[420px] overflow-auto px-4 py-4 [scrollbar-width:thin] md:h-[520px] [&_pre]:!bg-transparent [&_pre]:text-[12.5px] [&_pre]:leading-[1.65]"
            >
              {highlighted[active] ?? null}
            </div>

            {/* corner preview window — rendered email or resolved schedule */}
            {activeFile?.email || activeFile?.timing ? (
              <div
                key={`${active}-preview`}
                className="scaffold-preview-in absolute right-4 bottom-4 hidden w-[320px] overflow-hidden rounded-lg border border-white/[0.12] bg-[var(--tw-ink-high)] shadow-[0_24px_60px_rgba(0,0,0,0.55)] lg:block"
              >
                <div className="flex items-center justify-between border-white/[0.08] border-b px-3.5 py-2">
                  <span className="truncate font-mono text-[10.5px] text-white/60">
                    {activeFile.email ? active.split("/").pop() : "ctx.when"}
                  </span>
                  <span className="shrink-0 font-mono text-[9.5px] text-white/35 uppercase tracking-[0.08em]">
                    {activeFile.email ? "rendered" : "schedule"}
                  </span>
                </div>
                <div className="max-h-[300px] overflow-auto [scrollbar-width:thin]">
                  {activeFile.email ? (
                    <EmailPane email={activeFile.email} />
                  ) : (
                    <TimingPane />
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {/* small-screen preview — below the code, not floating */}
          {activeFile?.email || activeFile?.timing ? (
            <div className="border-white/[0.07] border-t lg:hidden">
              <div className="px-4 py-2 font-mono text-[10px] text-white/35 uppercase tracking-[0.08em]">
                {activeFile.email ? "Rendered" : "Schedule"}
              </div>
              <div className="max-h-[280px] overflow-auto">
                {activeFile.email ? (
                  <EmailPane email={activeFile.email} />
                ) : (
                  <TimingPane />
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
