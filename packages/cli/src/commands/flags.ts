import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend flags generate [options]

Generate the type-safe flag registry augmentation from your code-first flags.
Imports the \`flags\` array from src/flags/index.ts (each a \`defineFlag()\`),
infers every flag's served VALUE TYPE (boolean flag → \`boolean\`; multivariate →
the union of its variants' \`value\` literals; else \`unknown\`), and writes a
\`declare module "@hogsend/core"\` augmentation to src/flags/flags.d.ts. After
that, useFlag()/useFlags() (@hogsend/react), hogsend.getFlag() (@hogsend/js),
and client.flags.evaluate() (@hogsend/client) are type-checked against THIS
app's flag keys and narrow their values; a typo key is a compile error.

Deterministic + idempotent — safe to re-run and commit the result.

Options:
  --input <file>   Flags module (default: src/flags/index.ts, relative to --cwd).
  --out <file>     Output .d.ts (default: src/flags/flags.d.ts, relative to --cwd).
  --cwd <dir>      Consumer repo root (defaults to the current directory).
  -h, --help       Show this help.`;

/** A flag's contract as read from its runtime `meta` (JSON-serialized). */
interface FlagMeta {
  key: string;
  type: "boolean" | "multivariate";
  variants: { value: unknown }[];
  /**
   * The served default (disabled / unmatched / out-of-rollout). Reconcile stores
   * `defaultValue ?? (type === "boolean" ? false : null)`, so an omitted default
   * serves `null` for a multivariate flag — part of its served value type.
   */
  defaultValue?: unknown;
}

/**
 * Resolve the consumer's `tsx` binary so we can import a TypeScript flags
 * module in a child process (mirrors how the dev/worker scripts run under tsx).
 * The pnpm/npm `.bin` shim is the reliable entry.
 */
function resolveTsxBin(consumerRoot: string): string {
  const shim = join(consumerRoot, "node_modules", ".bin", "tsx");
  if (existsSync(shim)) return shim;
  // Fall back to the CLI package's own tsx (bundled as a devDependency).
  const own = join(dirname(dirname(dirname(import.meta.dirname))), "cli");
  const ownShim = join(own, "node_modules", ".bin", "tsx");
  if (existsSync(ownShim)) return ownShim;
  throw new Error(
    "could not find a `tsx` binary — install it in the app (pnpm add -D tsx)",
  );
}

/**
 * Import the consumer's flags module under tsx (a separate process, so the
 * heavy `@hogsend/engine` import resolves from THEIR node_modules) and return
 * each defined flag's `meta`. The loader emits only JSON on stdout.
 */
function loadFlagMetas(consumerRoot: string, inputPath: string): FlagMeta[] {
  const tsx = resolveTsxBin(consumerRoot);
  const inputUrl = pathToFileURL(inputPath).href;
  const loader = [
    "const input = process.argv[2];",
    "const mod = await import(input);",
    "const flags = Array.isArray(mod.flags) ? mod.flags : [];",
    "const metas = flags.map((f) => ({",
    "  key: f && f.meta ? f.meta.key : undefined,",
    "  type: f && f.meta ? f.meta.type : undefined,",
    "  variants: Array.isArray(f && f.meta && f.meta.variants)",
    "    ? f.meta.variants.map((v) => ({ value: v ? v.value : undefined }))",
    "    : [],",
    "  defaultValue: f && f.meta ? f.meta.defaultValue : undefined,",
    "}));",
    "process.stdout.write(JSON.stringify(metas));",
  ].join("\n");

  // Codegen is a STATIC, offline operation: it only reads each flag's `meta`.
  // But importing the consumer's module transitively loads `@hogsend/engine`,
  // which validates its env AND boots a Hatchet client at import time. Supply
  // benign placeholders so codegen never needs a live DB/Hatchet — any real
  // value (e.g. from a `.env` the wrapping script loaded) still wins. The
  // Hatchet token must be a WELL-FORMED JWT (the SDK parses `sub` +
  // server/grpc claims from it at `HatchetClient.init`); we mint a dummy one
  // and force the insecure TLS path so no connection is attempted.
  const placeholderJwt = makePlaceholderJwt();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgresql://placeholder:placeholder@localhost:5432/placeholder",
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ??
      "hogsend-flags-codegen-placeholder-secret",
    HATCHET_CLIENT_TOKEN: process.env.HATCHET_CLIENT_TOKEN ?? placeholderJwt,
    HATCHET_CLIENT_TLS_STRATEGY:
      process.env.HATCHET_CLIENT_TLS_STRATEGY ?? "none",
  };

  const dir = mkdtempSync(join(tmpdir(), "hogsend-flags-"));
  const loaderFile = join(dir, "load-flags.mjs");
  try {
    writeFileSync(loaderFile, loader, "utf8");
    const res = spawnSync(tsx, [loaderFile, inputUrl], {
      cwd: consumerRoot,
      encoding: "utf8",
      env: childEnv,
    });
    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout || "").trim();
      throw new Error(
        `failed to import ${inputPath}${detail ? `\n${detail}` : ""}`,
      );
    }
    const parsed = JSON.parse(res.stdout) as FlagMeta[];
    if (!Array.isArray(parsed)) {
      throw new Error(`${inputPath} did not export a \`flags\` array`);
    }
    return parsed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A syntactically-valid dummy Hatchet JWT (header.payload.sig) carrying the
 * claims the SDK reads at `HatchetClient.init` (`sub` + server/grpc addresses).
 * Never used for a real connection — codegen only imports the module graph.
 */
function makePlaceholderJwt(): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64({ alg: "none", typ: "JWT" });
  const payload = b64({
    sub: "hogsend-flags-codegen",
    server_url: "https://localhost",
    grpc_broadcast_address: "localhost:7077",
  });
  return `${header}.${payload}.placeholder`;
}

/** A single JSON-literal value → its TS literal, or `null` if not a literal. */
function valueLiteral(value: unknown): string | null {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

/** The served VALUE TYPE for a flag's `meta` (see the codegen contract). */
function valueType(meta: FlagMeta): string {
  if (meta.type === "boolean") return "boolean";
  if (meta.type === "multivariate") {
    const literals: string[] = [];
    const push = (lit: string): void => {
      if (!literals.includes(lit)) literals.push(lit);
    };
    for (const variant of meta.variants) {
      const lit = valueLiteral(variant.value);
      // Any non-literal arm makes the whole union un-inferable → `unknown`.
      if (lit === null) return "unknown";
      push(lit);
    }
    // A disabled / unmatched / out-of-rollout eval serves `defaultValue`, which
    // reconcile stores as `defaultValue ?? null` — so an omitted/null default
    // serves `null`. Fold it into the union (every flag is born disabled, so
    // this is the value most contacts actually get out of the box).
    if (meta.defaultValue === undefined || meta.defaultValue === null) {
      push("null");
    } else {
      const lit = valueLiteral(meta.defaultValue);
      // A non-literal default (object/array) is un-inferable → `unknown`.
      if (lit === null) return "unknown";
      push(lit);
    }
    return literals.length > 0 ? literals.join(" | ") : "unknown";
  }
  return "unknown";
}

/**
 * A flag key as a TS interface property name: emitted UNQUOTED when it is a
 * valid JS identifier, quoted otherwise. Mirrors Biome's default
 * `quoteProperties: "asNeeded"`, so the generated file stays lint-clean and
 * idempotent (a quoted identifier key would get reformatted on `pnpm lint` /
 * the pre-commit hook, churning against the codegen output).
 */
function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Render the deterministic `flags.d.ts` body. */
function renderDts(metas: FlagMeta[]): string {
  // Dedupe by key (first wins) and sort for stable output.
  const byKey = new Map<string, FlagMeta>();
  for (const meta of metas) {
    if (typeof meta.key === "string" && !byKey.has(meta.key)) {
      byKey.set(meta.key, meta);
    }
  }
  const sorted = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const lines = sorted.map(
    (meta) => `    ${propertyKey(meta.key)}: ${valueType(meta)};`,
  );
  const body = lines.length > 0 ? `\n${lines.join("\n")}\n  ` : "";
  return `// Generated by \`hogsend flags generate\` — DO NOT EDIT BY HAND.
// Regenerate whenever src/flags/index.ts changes. Augments FlagRegistryMap in
// @hogsend/core so useFlag()/useFlags() (@hogsend/react), hogsend.getFlag()
// (@hogsend/js), and client.flags.evaluate() (@hogsend/client) type-check this
// app's flag keys and narrow their served values.

import "@hogsend/core";

declare module "@hogsend/core" {
  interface FlagRegistryMap {${body}}
}
`;
}

async function run(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      input: { type: "string" },
      out: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals[0] !== "generate") {
    ctx.out.log(usage);
    return;
  }

  const consumerRoot = values.cwd ? resolve(values.cwd) : process.cwd();
  const inputRel = values.input ?? join("src", "flags", "index.ts");
  const outRel = values.out ?? join("src", "flags", "flags.d.ts");
  const inputPath = isAbsolute(inputRel)
    ? inputRel
    : resolve(consumerRoot, inputRel);
  const outPath = isAbsolute(outRel) ? outRel : resolve(consumerRoot, outRel);

  if (!existsSync(inputPath)) {
    ctx.out.fail(`flags module not found: ${inputPath}`);
  }

  const metas = ctx.out.isJson
    ? loadFlagMetas(consumerRoot, inputPath)
    : await ctx.out.step("Reading flag definitions", async () =>
        loadFlagMetas(consumerRoot, inputPath),
      );

  const dts = renderDts(metas);
  writeFileSync(outPath, dts, "utf8");

  const count = new Set(
    metas.filter((m) => typeof m.key === "string").map((m) => m.key),
  ).size;

  if (ctx.out.isJson) {
    ctx.out.json({ output: outPath, flags: count });
    return;
  }
  ctx.out.log(
    `${color.green("✓")} wrote ${outPath} (${count} flag${
      count === 1 ? "" : "s"
    })`,
  );
}

export const flagsCommand: Command = {
  name: "flags",
  summary: "Generate the type-safe flag registry (src/flags/flags.d.ts).",
  usage,
  run,
};
