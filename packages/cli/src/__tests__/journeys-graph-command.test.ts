import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journeysCommand } from "../commands/journeys.js";
import type { CommandContext } from "../commands/types.js";
import type { ResolvedConfig } from "../lib/config.js";
import type { AdminClient, DataPlaneClient } from "../lib/http.js";
import { mermaidLiveUrl } from "../lib/mermaid-live.js";
import type { Output } from "../lib/output.js";

class FailSignal extends Error {
  constructor(readonly msg: string) {
    super(msg);
    this.name = "FailSignal";
  }
}

interface Captured {
  logs: string[];
  jsonDocs: unknown[];
}

function makeCtx(
  argv: string[],
  json = false,
): { ctx: CommandContext; captured: Captured } {
  const captured: Captured = { logs: [], jsonDocs: [] };
  const out: Output = {
    interactive: false,
    isJson: json,
    intro: () => {},
    step: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    note: (body: string) => captured.logs.push(body),
    table: () => {},
    kv: () => {},
    log: (msg: string) => captured.logs.push(msg),
    json: (payload: unknown) => captured.jsonDocs.push(payload),
    outro: () => {},
    fail: (message: string): never => {
      throw new FailSignal(message);
    },
  };
  const cfg = {
    baseUrl: "http://x",
    adminKey: "k",
    dataKey: "d",
  } as ResolvedConfig;
  const http = {
    cfg,
    get: () => Promise.reject(new Error("unexpected GET")),
    post: () => Promise.reject(new Error("unexpected POST")),
    patch: () => Promise.reject(new Error("unexpected PATCH")),
    put: () => Promise.reject(new Error("unexpected PUT")),
    del: () => Promise.reject(new Error("unexpected DELETE")),
  } as AdminClient;
  const dataHttp = { ...http } as DataPlaneClient;
  const ctx: CommandContext = { argv, cfg, http, dataHttp, out, json };
  return { ctx, captured };
}

/** A minimal journey source fixture used across these tests. */
const JOURNEY_SRC = `
import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
export const welcome = defineJourney({
  meta: {
    id: "welcome",
    name: "Welcome",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppress: days(1),
    exitOn: [{ event: "user.deleted" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ subject: "Welcome aboard", template: "welcome" });
    await ctx.sleep({ duration: days(2), label: "post-welcome" });
  },
});
`;

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "journeys-graph-cmd-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("journeys graph subcommand", () => {
  it("renders a single journey to stdout as mermaid", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");

    const { ctx, captured } = makeCtx([
      "graph",
      "welcome",
      "--source",
      "src/journeys",
      "--cwd",
      tmpDir,
    ]);
    await journeysCommand.run(ctx);

    const out = captured.logs.join("\n");
    expect(out).toContain("flowchart TD");
    expect(out).toContain("user.created"); // trigger
    expect(out).toContain("send: Welcome aboard"); // email node
    expect(out).toContain("post-welcome"); // sleep node
  });

  it("emits JSON (graph + mermaid) with --json", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");

    const { ctx, captured } = makeCtx(
      ["graph", "welcome", "--source", "src/journeys", "--cwd", tmpDir],
      true,
    );
    await journeysCommand.run(ctx);

    expect(captured.jsonDocs).toHaveLength(1);
    const payload = captured.jsonDocs[0] as {
      graph: {
        journeyId: string;
        nodes: { kind: string }[];
        sourceFile?: string;
        sourceHash?: string;
      };
      mermaid: string;
    };
    expect(payload.graph.journeyId).toBe("welcome");
    expect(payload.graph.nodes.some((n) => n.kind === "email")).toBe(true);
    // The graph carries the code pointer + content hash for staleness checks.
    expect(payload.graph.sourceFile).toBe(
      join("src", "journeys", "welcome.ts"),
    );
    expect(payload.graph.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    // Mermaid rides along so agents/scripts don't re-render.
    expect(payload.mermaid).toContain("flowchart TD");
  });

  it("renders unicode boxes with --format ascii", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");

    const { ctx, captured } = makeCtx([
      "graph",
      "welcome",
      "--source",
      "src/journeys",
      "--cwd",
      tmpDir,
      "--format",
      "ascii",
    ]);
    await journeysCommand.run(ctx);

    const out = captured.logs.join("\n");
    // Box-drawing output, not mermaid source.
    expect(out).not.toContain("flowchart TD");
    expect(out).toContain("user.created");
    expect(out).toMatch(/[─│┌┐└┘]/);
  });

  it("renders an agent-friendly Markdown digest with --format summary", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");

    const { ctx, captured } = makeCtx([
      "graph",
      "welcome",
      "--source",
      "src/journeys",
      "--cwd",
      tmpDir,
      "--format",
      "summary",
    ]);
    await journeysCommand.run(ctx);

    const out = captured.logs.join("\n");
    // Markdown digest, not a diagram.
    expect(out).not.toContain("flowchart TD");
    expect(out).toContain("# welcome");
    expect(out).toContain("| Trigger | `user.created` |");
    expect(out).toContain("| Exit on | `user.deleted` |");
    // Sends section lists the email with its source pointer.
    expect(out).toContain("## Sends");
    expect(out).toContain("`Welcome aboard`");
    expect(out).toMatch(/src\/journeys\/welcome\.ts:\d+/);
    // Sleeps section captures the durable delay.
    expect(out).toContain("## Sleeps & schedules");
    expect(out).toContain("post-welcome");
  });

  it("rejects an unknown --format", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");

    const { ctx } = makeCtx([
      "graph",
      "welcome",
      "--source",
      "src/journeys",
      "--cwd",
      tmpDir,
      "--format",
      "png",
    ]);
    await expect(journeysCommand.run(ctx)).rejects.toThrow(/unknown --format/);
  });

  it("writes a fenced mermaid file with --out", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");
    const outPath = join(tmpDir, "out", "welcome.md");

    const { ctx } = makeCtx([
      "graph",
      "welcome",
      "--source",
      "src/journeys",
      "--cwd",
      tmpDir,
      "--out",
      outPath,
    ]);
    await journeysCommand.run(ctx);

    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("```mermaid");
    expect(content).toContain("flowchart TD");
  });

  it("fails when the journey id is not found", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    const { ctx } = makeCtx([
      "graph",
      "nope",
      "--source",
      "src/journeys",
      "--cwd",
      tmpDir,
    ]);
    await expect(journeysCommand.run(ctx)).rejects.toThrow(/not found/);
  });

  it("generates markdown + manifest with --all", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");

    const { ctx, captured } = makeCtx([
      "graph",
      "--all",
      "--source",
      "src/journeys",
      "--cwd",
      tmpDir,
    ]);
    await journeysCommand.run(ctx);

    // Default outputs written.
    expect(existsSync(join(tmpDir, "docs", "journeys.md"))).toBe(true);
    expect(existsSync(join(tmpDir, ".hogsend", "journeys.graph.json"))).toBe(
      true,
    );

    const note = captured.logs.join("\n");
    expect(note).toContain("1 journey(s) graphed");
    expect(note).toContain("markdown:");
    expect(note).toContain("manifest:");

    // The markdown contains the journey section.
    const md = readFileSync(join(tmpDir, "docs", "journeys.md"), "utf8");
    expect(md).toContain("## welcome");
    expect(md).toContain("```mermaid");
    expect(md).toContain("## Legend");
  });

  it("generates the fumadocs mirror when --fumadocs points at an existing dir", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");
    const docsDir = join(tmpDir, "content", "docs");
    mkdirSync(docsDir, { recursive: true });

    const { ctx } = makeCtx([
      "graph",
      "--all",
      "--source",
      "src/journeys",
      "--fumadocs",
      "content/docs",
      "--cwd",
      tmpDir,
    ]);
    await journeysCommand.run(ctx);

    const page = join(docsDir, "journeys", "index.mdx");
    const meta = join(docsDir, "journeys", "meta.json");
    expect(existsSync(page)).toBe(true);
    expect(existsSync(meta)).toBe(true);
    expect(readFileSync(meta, "utf8")).toContain('"title": "Journeys"');
    expect(readFileSync(page, "utf8")).toContain("## welcome");
  });

  it("warns (instead of silently skipping) when --fumadocs dir is missing", async () => {
    const src = join(tmpDir, "src", "journeys");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "welcome.ts"), JOURNEY_SRC, "utf8");

    const { ctx, captured } = makeCtx(
      [
        "graph",
        "--all",
        "--source",
        "src/journeys",
        "--fumadocs",
        "does/not/exist",
        "--cwd",
        tmpDir,
      ],
      true,
    );
    await journeysCommand.run(ctx);

    const payload = captured.jsonDocs[0] as { warnings: string[] };
    expect(payload.warnings.some((w) => w.includes("does/not/exist"))).toBe(
      true,
    );
  });
});

describe("mermaidLiveUrl", () => {
  it("produces a pako link that round-trips back to the diagram", () => {
    const code = "flowchart TD\n  a --> b";
    const url = mermaidLiveUrl(code);
    expect(url.startsWith("https://mermaid.live/edit#pako:")).toBe(true);
    const b64 = url.split("#pako:")[1] as string;
    const state = JSON.parse(
      inflateSync(Buffer.from(b64, "base64url")).toString("utf8"),
    ) as { code: string };
    expect(state.code).toBe(code);
  });
});
