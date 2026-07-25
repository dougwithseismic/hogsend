import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getBootDiagnostics } from "./boot-diagnostics.js";
import {
  loadOptionalPlugin,
  type PluginLoadOutcome,
} from "./load-optional-plugin.js";

/**
 * Look up a recorded boot diagnostic by exact code. Assertions here target
 * SPECIFIC codes (or deltas), never absolute collector counts: the collector
 * is process-global and `clearBootDiagnostics()` would permanently discard
 * module-scope loader recordings (modules never re-evaluate), so a count
 * assertion can pass or fail for reasons unrelated to what it claims.
 */
function diagnostic(code: string) {
  return getBootDiagnostics().find((d) => d.code === code);
}

function collect() {
  const seen: Array<{ message: string; outcome: PluginLoadOutcome }> = [];
  return {
    seen,
    onFailure: (message: string, outcome: PluginLoadOutcome) =>
      seen.push({ message, outcome }),
  };
}

test("resolvable specifier → returns the named export, logs nothing", async () => {
  // The control. Proves a null below comes from the specifier, not a broken
  // loader.
  const { seen, onFailure } = collect();
  // Delta, not absolute count (see `diagnostic` above): a successful load must
  // not add a diagnostic, but OTHER module-scope recordings may already exist.
  const before = getBootDiagnostics().length;
  const factory = await loadOptionalPlugin<typeof import("node:path")["join"]>({
    specifier: "node:path",
    exportName: "join",
    enabledBy: "TEST is set",
    onFailure,
  });
  assert.equal(typeof factory, "function");
  assert.equal(seen.length, 0);
  assert.equal(getBootDiagnostics().length, before);
});

test("absent package → not-installed, names the install command", async () => {
  // An INJECTED unresolvable specifier, never a real @hogsend plugin: those are
  // engine optionalDependencies, so an absence-based test would silently invert
  // its own meaning the moment the package resolves.
  const { seen, onFailure } = collect();
  const factory = await loadOptionalPlugin({
    specifier: "@hogsend/plugin-test-does-not-exist",
    exportName: "createTestProvider",
    enabledBy: "TEST_TOKEN is set",
    onFailure,
  });
  assert.equal(factory, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.outcome, "not-installed");
  assert.match(
    seen[0]?.message ?? "",
    /pnpm add @hogsend\/plugin-test-does-not-exist/,
  );
  // The reason it was attempted at all must be in the message — otherwise the
  // operator cannot tell which credential switched this on.
  assert.match(seen[0]?.message ?? "", /TEST_TOKEN is set/);
  // The direct-dependency nuance is the entire point: an engine
  // optionalDependency is installed but never linked at the consumer's top
  // level, so a bundled app cannot resolve it.
  assert.match(seen[0]?.message ?? "", /DIRECT dependency/);
  // AC2: the failure is also recorded as a boot diagnostic (the queryable
  // second channel), coded by outcome + specifier and carrying the SAME
  // message the operator saw on stdout.
  const recorded = diagnostic(
    "plugin.not-installed:@hogsend/plugin-test-does-not-exist",
  );
  assert.ok(recorded, "expected a plugin.not-installed boot diagnostic");
  assert.equal(recorded.message, seen[0]?.message);
});

test("present but broken → load-failed, and does NOT say 'not installed'", async () => {
  // The regression that motivated this module. The old loader reported every
  // failure as "is not installed", so an operator whose package WAS installed
  // (but shipped raw .ts that Node cannot type-strip under node_modules) was
  // told to reinstall it — advice that could never work. A load failure must
  // never be described as an absence.
  const { seen, onFailure } = collect();
  const factory = await loadOptionalPlugin({
    // Resolves, then throws on evaluation.
    specifier: "data:text/javascript,throw new Error('boom on evaluate')",
    exportName: "createTestProvider",
    enabledBy: "TEST_TOKEN is set",
    onFailure,
  });
  assert.equal(factory, null);
  assert.equal(seen[0]?.outcome, "load-failed");
  assert.doesNotMatch(seen[0]?.message ?? "", /is not installed/);
  assert.match(seen[0]?.message ?? "", /boom on evaluate/);
  assert.match(seen[0]?.message ?? "", /packaging bug/);
  // AC2: recorded under the load-failed (not not-installed) code — the two
  // failure modes are different problems, and the diagnostic must keep them
  // apart just like the log message does.
  const recorded = diagnostic(
    "plugin.load-failed:data:text/javascript,throw new Error('boom on evaluate')",
  );
  assert.ok(recorded, "expected a plugin.load-failed boot diagnostic");
  assert.equal(recorded.message, seen[0]?.message);
});

test("a MISSING TRANSITIVE dep is not reported as the plugin being absent", async () => {
  // The case that forces classification to inspect the message, not just the
  // code. "plugin-twilio is installed but `twilio` is not" throws the SAME
  // ERR_MODULE_NOT_FOUND as "plugin-twilio is not installed"; keying on the
  // code alone would tell the operator to reinstall a package that is already
  // there while the real gap goes unnamed.
  //
  // This needs a real file on disk. A `data:` URL cannot resolve bare
  // specifiers at all (ERR_UNSUPPORTED_RESOLVE_REQUEST), and a `node:`-prefixed
  // miss throws ERR_UNKNOWN_BUILTIN_MODULE — neither reaches this branch, so
  // either would pass while testing nothing.
  const dir = await mkdtemp(join(tmpdir(), "hogsend-plugin-load-"));
  try {
    const file = join(dir, "broken.mjs");
    await writeFile(
      file,
      'import "totally-not-a-real-package-xyz";\nexport const createTestProvider = () => {};\n',
    );
    const { seen, onFailure } = collect();
    const factory = await loadOptionalPlugin({
      specifier: pathToFileURL(file).href,
      exportName: "createTestProvider",
      enabledBy: "TEST_TOKEN is set",
      onFailure,
    });
    assert.equal(factory, null);
    assert.equal(seen[0]?.outcome, "load-failed");
    assert.doesNotMatch(seen[0]?.message ?? "", /is not installed/);
    // The missing package must be named, or the operator learns nothing.
    assert.match(seen[0]?.message ?? "", /totally-not-a-real-package-xyz/);
    // AC2: the code embeds the ACTUAL failing specifier (here a file URL), so
    // two different broken plugins yield two diagnostics, never one.
    assert.ok(
      diagnostic(`plugin.load-failed:${pathToFileURL(file).href}`),
      "expected the diagnostic code to carry this specifier",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolvable but missing the named export → missing-export, flags version skew", async () => {
  const { seen, onFailure } = collect();
  const factory = await loadOptionalPlugin({
    specifier: "node:path",
    exportName: "createApolloProvider",
    enabledBy: "APOLLO_API_KEY is set",
    onFailure,
  });
  assert.equal(factory, null);
  assert.equal(seen[0]?.outcome, "missing-export");
  assert.match(
    seen[0]?.message ?? "",
    /does not export "createApolloProvider"/,
  );
  assert.match(seen[0]?.message ?? "", /version/);
  // AC2: the third loader outcome records too — every failure path, not just
  // the import-throwing ones.
  const recorded = diagnostic("plugin.missing-export:node:path");
  assert.ok(recorded, "expected a plugin.missing-export boot diagnostic");
  assert.equal(recorded.message, seen[0]?.message);
});
