import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eject } from "../eject.js";

const PKG = "@hogsend/engine";

let root: string;
let sourceDir: string;
let consumerRoot: string;

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T = Record<string, unknown>>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function fabricateSource(): Promise<void> {
  await mkdir(join(sourceDir, "src", "lib"), { recursive: true });
  await mkdir(join(sourceDir, "node_modules"), { recursive: true });
  await mkdir(join(sourceDir, "dist"), { recursive: true });
  await writeJson(join(sourceDir, "package.json"), {
    name: "@hogsend/engine",
    version: "0.0.1",
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@hogsend/core": "workspace:^" },
  });
  await writeFile(join(sourceDir, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(
    join(sourceDir, "src", "lib", "db.ts"),
    "export const db = 1;\n",
    "utf8",
  );
  await writeFile(
    join(sourceDir, "src", "foo.test.ts"),
    "// a test file\n",
    "utf8",
  );
  await writeFile(
    join(sourceDir, "node_modules", "junk.js"),
    "module.exports = {};\n",
    "utf8",
  );
  await writeFile(join(sourceDir, "dist", "old.js"), "// stale\n", "utf8");
}

async function fabricateConsumer(
  deps: Record<string, string> = {
    "@hogsend/engine": "workspace:^",
    "@hogsend/core": "workspace:^",
  },
): Promise<void> {
  await mkdir(consumerRoot, { recursive: true });
  await writeJson(join(consumerRoot, "package.json"), {
    name: "consumer-app",
    version: "0.0.0",
    type: "module",
    dependencies: deps,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hogsend-eject-"));
  sourceDir = join(root, "src-pkg");
  consumerRoot = join(root, "consumer");
  await fabricateSource();
  await fabricateConsumer();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("eject", () => {
  it("copies the right files into vendor/<name>", async () => {
    await eject({ pkg: PKG, consumerRoot, sourceDir });
    expect(
      existsSync(join(consumerRoot, "vendor", "engine", "src", "index.ts")),
    ).toBe(true);
    expect(
      existsSync(join(consumerRoot, "vendor", "engine", "src", "lib", "db.ts")),
    ).toBe(true);
    expect(
      existsSync(join(consumerRoot, "vendor", "engine", "package.json")),
    ).toBe(true);
  });

  it("honors excludes (node_modules, dist, *.test.ts)", async () => {
    await eject({ pkg: PKG, consumerRoot, sourceDir });
    expect(
      existsSync(join(consumerRoot, "vendor", "engine", "node_modules")),
    ).toBe(false);
    expect(existsSync(join(consumerRoot, "vendor", "engine", "dist"))).toBe(
      false,
    );
    expect(
      existsSync(join(consumerRoot, "vendor", "engine", "src", "foo.test.ts")),
    ).toBe(false);
  });

  it("rewrites only the target consumer dep, leaving others untouched", async () => {
    await eject({ pkg: PKG, consumerRoot, sourceDir });
    const pkg = await readJson(join(consumerRoot, "package.json"));
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps["@hogsend/engine"]).toBe("file:./vendor/engine");
    expect(deps["@hogsend/core"]).toBe("workspace:^");
  });

  it("sanitizes the vendored package.json", async () => {
    await eject({ pkg: PKG, consumerRoot, sourceDir });
    const vendored = await readJson(
      join(consumerRoot, "vendor", "engine", "package.json"),
    );
    expect("private" in vendored).toBe(false);
    expect(vendored.name).toBe("@hogsend/engine");
    const deps = vendored.dependencies as Record<string, string>;
    expect(deps["@hogsend/core"]).toBe("workspace:^");
  });

  it("returns the expected result shape", async () => {
    const result = await eject({ pkg: PKG, consumerRoot, sourceDir });
    expect(result.depSpecBefore).toBe("workspace:^");
    expect(result.depSpecAfter).toBe("file:./vendor/engine");
    expect(result.followUp).toBe("pnpm install");
    expect(result.copiedFiles).toBeGreaterThanOrEqual(3);
    expect(result.vendorPath).toBe(join(consumerRoot, "vendor", "engine"));
    expect(result.pkg).toBe(PKG);
  });

  it("refuses to clobber an existing vendor dir without force", async () => {
    await eject({ pkg: PKG, consumerRoot, sourceDir });
    await expect(eject({ pkg: PKG, consumerRoot, sourceDir })).rejects.toThrow(
      /already exists/,
    );
  });

  it("overwrites with force and drops files removed from source", async () => {
    await eject({ pkg: PKG, consumerRoot, sourceDir });
    // Remove a file from source between runs.
    await rm(join(sourceDir, "src", "lib", "db.ts"));
    await eject({ pkg: PKG, consumerRoot, sourceDir, force: true });
    expect(
      existsSync(join(consumerRoot, "vendor", "engine", "src", "lib", "db.ts")),
    ).toBe(false);
    expect(
      existsSync(join(consumerRoot, "vendor", "engine", "src", "index.ts")),
    ).toBe(true);
  });

  it("errors loudly when the package is not a dependency", async () => {
    await fabricateConsumer({ "@hogsend/core": "workspace:^" });
    await expect(eject({ pkg: PKG, consumerRoot, sourceDir })).rejects.toThrow(
      /not a dependency/,
    );
    expect(existsSync(join(consumerRoot, "vendor"))).toBe(false);
  });
});
