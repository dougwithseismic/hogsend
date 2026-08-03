import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  findScaffoldRoot,
  resolveEngineVersion,
  ScaffoldError,
} from "../lib/publish-manifest.js";

/**
 * Two questions the manifest answers, both of which have to come from the
 * REPOSITORY rather than from a flag: which directory is the app, and which
 * engine version it is built against.
 *
 * The version matters most: it is what the control plane refuses a mismatched
 * deploy on, so a resolution that silently picks the wrong source would turn
 * that gate into a formality. Each source is asserted independently, and so is
 * the PRECEDENCE between them — a lockfile beats an installed copy beats the
 * declared range, because that is the order of "what an install would actually
 * produce".
 */

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hogsend-manifest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, contents: string): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function scaffoldPackage(range = "^0.57.0"): void {
  write(
    "package.json",
    JSON.stringify({
      name: "acme-lifecycle",
      dependencies: { "@hogsend/engine": range, hono: "^4" },
    }),
  );
}

const PNPM_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@hogsend/engine':
        specifier: ^0.57.0
        version: 0.57.3
      hono:
        specifier: ^4.0.0
        version: 4.9.1
`;

describe("findScaffoldRoot", () => {
  it("walks UP to the nearest package.json depending on the engine", () => {
    scaffoldPackage();
    mkdirSync(join(root, "src", "journeys"), { recursive: true });

    const found = findScaffoldRoot(join(root, "src", "journeys"));
    expect(found.dir).toBe(root);
    expect(found.appName).toBe("acme-lifecycle");
    expect(found.engineRange).toBe("^0.57.0");
  });

  it("stops at the INNER app in a monorepo, not the workspace root", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "workspace",
        dependencies: { "@hogsend/engine": "^0.1.0" },
      }),
    );
    write(
      "apps/api/package.json",
      JSON.stringify({
        name: "acme-api",
        dependencies: { "@hogsend/engine": "^0.57.0" },
      }),
    );

    const found = findScaffoldRoot(join(root, "apps", "api"));
    expect(found.appName).toBe("acme-api");
  });

  it("finds the engine in devDependencies too", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "acme",
        devDependencies: { "@hogsend/engine": "0.57.0" },
      }),
    );
    expect(findScaffoldRoot(root).engineRange).toBe("0.57.0");
  });

  it("refuses a directory that is not a Hogsend app", () => {
    write("package.json", JSON.stringify({ name: "unrelated" }));
    expect(() => findScaffoldRoot(root)).toThrow(ScaffoldError);
  });
});

describe("resolveEngineVersion", () => {
  it("prefers the pnpm lockfile's RESOLVED version over the declared range", () => {
    scaffoldPackage("^0.57.0");
    write("pnpm-lock.yaml", PNPM_LOCK);

    // The range would have said 0.57.0; the lockfile says what an install
    // actually produces, and that is what the stack will be compared against.
    expect(resolveEngineVersion(root)).toEqual({
      version: "0.57.3",
      source: "pnpm-lock",
    });
  });

  it("reads an npm lockfile (v3 packages, then legacy dependencies)", () => {
    scaffoldPackage();
    write(
      "package-lock.json",
      JSON.stringify({
        packages: { "node_modules/@hogsend/engine": { version: "0.56.1" } },
      }),
    );
    expect(resolveEngineVersion(root)).toEqual({
      version: "0.56.1",
      source: "package-lock",
    });

    rmSync(join(root, "package-lock.json"));
    write(
      "package-lock.json",
      JSON.stringify({
        dependencies: { "@hogsend/engine": { version: "0.55.9" } },
      }),
    );
    expect(resolveEngineVersion(root).version).toBe("0.55.9");
  });

  it("reads a yarn classic lockfile", () => {
    scaffoldPackage();
    write(
      "yarn.lock",
      [
        '"@hogsend/engine@^0.57.0":',
        '  version "0.57.2"',
        '  resolved "https://registry.npmjs.org/@hogsend/engine/-/engine-0.57.2.tgz"',
        "",
      ].join("\n"),
    );
    expect(resolveEngineVersion(root)).toEqual({
      version: "0.57.2",
      source: "yarn-lock",
    });
  });

  it("falls back to node_modules when no lockfile is committed", () => {
    scaffoldPackage();
    write(
      "node_modules/@hogsend/engine/package.json",
      JSON.stringify({ name: "@hogsend/engine", version: "0.57.4" }),
    );
    expect(resolveEngineVersion(root)).toEqual({
      version: "0.57.4",
      source: "node_modules",
    });
  });

  it("falls back LAST to the declared range with its operator stripped", () => {
    // The documented lossy path: `^0.57.0` is the FLOOR of the range, not what
    // an install would pick. It is deliberately last, and a wrong answer here
    // surfaces as the intake's 409 rather than as a silent deploy.
    scaffoldPackage("^0.57.0");
    expect(resolveEngineVersion(root)).toEqual({
      version: "0.57.0",
      source: "package.json",
    });

    scaffoldPackage(">=0.58.1");
    expect(resolveEngineVersion(root).version).toBe("0.58.1");
  });

  it("refuses a range that is not a version at all", () => {
    scaffoldPackage("workspace:*");
    expect(() => resolveEngineVersion(root)).toThrow(ScaffoldError);

    scaffoldPackage("latest");
    expect(() => resolveEngineVersion(root)).toThrow(ScaffoldError);
  });
});

describe("buildManifest", () => {
  it("carries exactly what the intake reads", () => {
    expect(
      buildManifest({
        appName: "acme-lifecycle",
        engineVersion: "0.57.3",
        allowUpgrade: true,
        nodeVersion: "22.13.0",
      }),
    ).toEqual({
      appName: "acme-lifecycle",
      engineVersion: "0.57.3",
      nodeVersion: "22.13.0",
      allowUpgrade: true,
    });
  });

  it("defaults nodeVersion to this runtime's, bare", () => {
    const manifest = buildManifest({
      appName: "a",
      engineVersion: "0.1.0",
      allowUpgrade: false,
    });
    expect(manifest.nodeVersion).toBe(process.versions.node);
    expect(manifest.nodeVersion.startsWith("v")).toBe(false);
  });
});
