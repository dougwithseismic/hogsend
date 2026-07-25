import assert from "node:assert/strict";
import test from "node:test";
import {
  clearBootDiagnostics,
  getBootDiagnostics,
  recordBootDiagnostic,
} from "./boot-diagnostics.js";

// The collector is process-global on purpose (see boot-diagnostics.ts), so
// every test starts by clearing it — otherwise recordings leak between tests
// in whatever order the runner picks. Note this also permanently discards any
// module-scope recordings (the plugin loaders) for the rest of the process,
// which is why these tests only ever assert on codes THEY recorded, never on
// absolute collector counts.

test("recording the same code twice holds exactly one entry", () => {
  clearBootDiagnostics();
  recordBootDiagnostic({ code: "email.no-provider", message: "first" });
  recordBootDiagnostic({ code: "email.no-provider", message: "second" });
  const diags = getBootDiagnostics();
  assert.equal(diags.filter((d) => d.code === "email.no-provider").length, 1);
});

test("re-recording a code replaces the message — last write wins", () => {
  // `createHogsendClient` runs more than once per process (API + worker in
  // dev, repeatedly across a test file); the freshest description of the same
  // condition is the one an operator should see.
  clearBootDiagnostics();
  recordBootDiagnostic({ code: "sms.no-sender", message: "stale" });
  recordBootDiagnostic({ code: "sms.no-sender", message: "fresh" });
  const entry = getBootDiagnostics().find((d) => d.code === "sms.no-sender");
  assert.equal(entry?.message, "fresh");
});

test("reads come back in FIRST-record insertion order; a re-record does not move an entry", () => {
  // Stable ordering keeps `/v1/admin/config` and doctor output from
  // reshuffling between requests just because a container was rebuilt.
  clearBootDiagnostics();
  recordBootDiagnostic({ code: "a", message: "a1" });
  recordBootDiagnostic({ code: "b", message: "b1" });
  recordBootDiagnostic({ code: "c", message: "c1" });
  // Re-record the FIRST code — it must keep its slot, not jump to the end.
  recordBootDiagnostic({ code: "a", message: "a2" });
  assert.deepEqual(
    getBootDiagnostics().map((d) => d.code),
    ["a", "b", "c"],
  );
  assert.equal(getBootDiagnostics()[0]?.message, "a2");
});

test("mutating the returned array does not touch the collector's state", () => {
  clearBootDiagnostics();
  recordBootDiagnostic({ code: "x", message: "kept" });
  const first = getBootDiagnostics();
  // The readonly type stops TypeScript, not a JS caller — the runtime copy is
  // what actually protects the collector.
  (first as unknown as Array<{ code: string; message: string }>).length = 0;
  assert.equal(getBootDiagnostics().length, 1);
  assert.equal(getBootDiagnostics()[0]?.code, "x");
});
