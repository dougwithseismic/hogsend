import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const stampLoader = require("../../packages/inspector/loader/stamp-loader.cjs");
const { withInspector } = await import("../../packages/inspector/src/next.ts");
const docsRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(docsRoot, "../..");
const configSource = await readFile(
  new URL("./next.config.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("./package.json", import.meta.url), "utf8"),
);
const includeBlock = configSource.match(
  /export default withInspector\([\s\S]*?include:\s*\[([^\]]*)\]/,
);

assert.ok(
  includeBlock,
  "docs Next config must declare inspector include paths",
);

const include = [...includeBlock[1].matchAll(/["']([^"']+)["']/g)].map(
  ([, fragment]) => fragment,
);
const fixture = "export function Example() { return <h1>Hello</h1>; }";

function stamp(relativePath) {
  return stampLoader.call(
    {
      resourcePath: path.join(workspaceRoot, relativePath),
      getOptions: () => ({ root: docsRoot, include }),
    },
    fixture,
  );
}

test("wires the source-stamping loader for TSX and JSX", () => {
  const config = withInspector({}, { root: docsRoot, include });

  for (const glob of ["*.tsx", "*.jsx"]) {
    const rule = config.turbopack?.rules?.[glob];
    assert.equal(rule?.loaders?.length, 1, `${glob} should use one loader`);
    assert.deepEqual(rule.loaders[0].options, {
      root: docsRoot,
      include,
    });
  }
});

test("builds the ignored inspector dist before local docs development", () => {
  assert.equal(
    packageJson.scripts?.predev,
    "pnpm --filter @hogsend/inspector build",
  );
});

test("stamps representative marketing JSX across apps/docs", () => {
  for (const relativePath of [
    "apps/docs/app/(landing)/page.tsx",
    "apps/docs/app/(home)/pricing/page.tsx",
    "apps/docs/components/landing/site-nav.tsx",
    "apps/docs/components/landing/example.jsx",
  ]) {
    assert.match(
      stamp(relativePath),
      /data-hs-source=/,
      `${relativePath} should be editable`,
    );
  }
});

test("leaves MDX and TSX outside apps/docs untouched", () => {
  for (const relativePath of [
    "apps/docs/content/docs/index.mdx",
    "apps/course/app/page.tsx",
  ]) {
    assert.doesNotMatch(
      stamp(relativePath),
      /data-hs-source=/,
      `${relativePath} should not be stamped`,
    );
  }
});
