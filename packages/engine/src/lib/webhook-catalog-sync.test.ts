import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WEBHOOK_EVENT_TYPES } from "./webhook-signing.js";

/**
 * THE DRIFT CHECK the outbound catalog never had.
 *
 * `WEBHOOK_EVENT_TYPES` is vendored into two copies that cannot import the
 * engine — the CLI's own tuple and the client's `OutboundEventType` union — and
 * until this file the only thing keeping them in sync was a comment asking
 * nicely. Every event added since has been a coin flip.
 *
 * So: read the two vendored files off disk and compare the FULL sets, not just
 * the newest member. Whoever adds event 32 and forgets a copy gets a failing
 * test naming the file they missed, rather than a subscriber who can never
 * register for it.
 *
 * This is a monorepo-source check by construction — it reads sibling packages'
 * `src/`, which is exactly the coupling it is asserting.
 */

const CLI_CATALOG = fileURLToPath(
  new URL("../../../cli/src/commands/webhooks.ts", import.meta.url),
);
const CLIENT_CATALOG = fileURLToPath(
  new URL("../../../client/src/types.ts", import.meta.url),
);

/** The source between `start` and the next `end`, exclusive. */
function between(file: string, start: string, end: string): string {
  const source = readFileSync(file, "utf8");
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${file}: could not find \`${start}\``);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(
    to,
    -1,
    `${file}: could not find \`${end}\` after \`${start}\``,
  );
  return source.slice(from + start.length, to);
}

/** Every `"<namespace>.<name>"` literal in a block of source. */
function eventLiterals(block: string): string[] {
  return [...block.matchAll(/"([a-z]+\.[a-z_]+)"/g)].map(
    (match) => match[1] as string,
  );
}

function readCliCatalog(): string[] {
  return eventLiterals(
    between(CLI_CATALOG, "const WEBHOOK_EVENT_TYPES = [", "] as const;"),
  );
}

function readClientCatalog(): string[] {
  return eventLiterals(
    between(CLIENT_CATALOG, "export type OutboundEventType =", ";"),
  );
}

/** Set-wise, because the three copies are not in the same ORDER (they never
 * have been) — only membership is load-bearing. */
function assertSameSet(actual: string[], expected: string[], what: string) {
  const missing = expected.filter((event) => !actual.includes(event));
  const extra = actual.filter(
    (event) => !(expected as string[]).includes(event),
  );
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${what} has drifted from the engine's WEBHOOK_EVENT_TYPES`,
  );
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${what} contains a duplicate entry`,
  );
}

test("AC 4: contact.refined is present in ALL THREE hand-synced catalogs", () => {
  assert.ok(
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes("contact.refined"),
    "engine WEBHOOK_EVENT_TYPES is missing contact.refined",
  );
  assert.ok(
    readCliCatalog().includes("contact.refined"),
    "packages/cli/src/commands/webhooks.ts is missing contact.refined",
  );
  assert.ok(
    readClientCatalog().includes("contact.refined"),
    "packages/client/src/types.ts is missing contact.refined",
  );
});

test("AC: the three account.* events are present in ALL THREE hand-synced catalogs", () => {
  const engine = WEBHOOK_EVENT_TYPES as readonly string[];
  const cli = readCliCatalog();
  const client = readClientCatalog();
  for (const event of [
    "account.linked",
    "account.unlinked",
    "account.link_failed",
  ]) {
    assert.ok(
      engine.includes(event),
      `packages/engine/src/lib/webhook-signing.ts is missing ${event}`,
    );
    assert.ok(
      cli.includes(event),
      `packages/cli/src/commands/webhooks.ts is missing ${event}`,
    );
    assert.ok(
      client.includes(event),
      `packages/client/src/types.ts is missing ${event}`,
    );
  }
});

test("AC 4: the CLI's vendored catalog is the engine catalog, entry for entry", () => {
  assertSameSet(
    readCliCatalog(),
    [...WEBHOOK_EVENT_TYPES],
    "packages/cli/src/commands/webhooks.ts",
  );
});

test("AC 4: the client's OutboundEventType union is the engine catalog, entry for entry", () => {
  assertSameSet(
    readClientCatalog(),
    [...WEBHOOK_EVENT_TYPES],
    "packages/client/src/types.ts",
  );
});
