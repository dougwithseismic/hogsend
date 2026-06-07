#!/usr/bin/env node
/**
 * verify-published — post-publish registry verification.
 *
 *   node scripts/verify-published.mjs '<publishedPackages JSON>'
 *
 * `changeset publish` can print "🦋 success @hogsend/<x>@<v>" and push a git tag
 * while the package never actually landed on npm — most notoriously when the CI
 * token cannot CREATE a brand-new package name (it can only publish new versions
 * of existing ones). The workflow stays green; the registry 404s; a fresh
 * `create-hogsend` install then breaks. This step closes that gap by GETting
 * every just-published `<name>@<version>` straight from the registry and failing
 * the workflow loudly if any is missing.
 *
 * Input is the changesets/action `publishedPackages` output — a JSON array of
 * `{ name, version }`. Empty / absent input is a no-op (nothing was published).
 */
const arg = process.argv[2];
if (!arg || arg.trim() === "") {
  console.log(
    "verify-published: no publishedPackages provided; nothing to verify",
  );
  process.exit(0);
}

let pkgs;
try {
  pkgs = JSON.parse(arg);
} catch {
  console.error(
    `verify-published: could not parse publishedPackages JSON: ${arg}`,
  );
  process.exit(1);
}

if (!Array.isArray(pkgs) || pkgs.length === 0) {
  console.log(
    "verify-published: publishedPackages is empty; nothing to verify",
  );
  process.exit(0);
}

let failed = 0;
for (const { name, version } of pkgs) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
  let ok = false;
  let detail = "no response";
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    ok = res.ok;
    detail = `HTTP ${res.status}`;
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }
  if (ok) {
    console.log(`✓ ${name}@${version} resolves on the registry`);
  } else {
    failed += 1;
    console.error(`✗ ${name}@${version} NOT on the registry (${detail})`);
  }
}

if (failed) {
  console.error(
    `\nverify-published: ${failed} package(s) reported published but are MISSING from npm. ` +
      "A brand-new package's first publish may need to be done manually — see docs/RELEASING.md.",
  );
  process.exit(1);
}
console.log(
  `\nverify-published: all ${pkgs.length} published package(s) resolve on npm`,
);
