import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `account-link-events.ts` is deliberately RUNTIME-import-free (its only
// imports are `import type`), so no env stub is needed here — importing it
// must never drag `env.ts` (which validates at import time) into a test.
const {
  buildAccountLinkedPayload,
  buildAccountUnlinkedPayload,
  buildDedupeKey,
  buildLinkFailedPayload,
} = await import("./account-link-events.js");

const AT = new Date("2026-08-14T12:00:00.000Z");

test("buildDedupeKey escapes nothing and is a pure template", () => {
  assert.equal(
    buildDedupeKey("steam", "76561198000000000", "3"),
    "al:steam:76561198000000000:v3",
  );

  // A REGRESSION PIN. Someone will one day be tempted to URL-encode or
  // normalize these segments; the moment they do, the key for a version
  // emitted before the change no longer matches the key emitted after it, and
  // the `(endpointId, dedupeKey)` dedupe silently stops deduping. Every
  // segment must survive VERBATIM.
  assert.equal(
    buildDedupeKey("twitch:beta", "user id/with?chars&+%", "9007199254740995"),
    "al:twitch:beta:user id/with?chars&+%:v9007199254740995",
  );

  // `version` is a STRING in and a STRING out — never parsed, never Number()'d
  // (DECISIONS §5.1). An odd value above 2^53 is the only one that can catch a
  // round-trip through float64.
  assert.equal(
    buildDedupeKey("steam", "u", "9007199254740995"),
    "al:steam:u:v9007199254740995",
  );
});

test("buildAccountLinkedPayload carries owner.userId and owner.email, not the provider email", () => {
  const payload = buildAccountLinkedPayload(
    {
      status: "linked",
      relink: false,
      version: "7",
      owner: {
        contactId: "contact-1",
        userId: "player-42",
        email: "player@contact.example",
      },
      row: {
        id: "row-1",
        contactId: "contact-1",
        provider: "steam",
        providerUserId: "76561198000000000",
        username: "gaben",
        // The provider-reported address. It is a display property at most
        // (DECISIONS §6.3/§6.4) and must NEVER surface in a field named
        // `email` next to `contactId` — that is exactly how a downstream
        // system ends up resolving on it.
        verifiedEmail: "provider-reported@steam.example",
        avatarUrl: null,
        method: "oauth",
        singleton: true,
        version: "7",
        linkedAt: AT,
        unlinkedAt: null,
        unlinkReason: null,
        tokensRevokedAt: null,
        hasTokens: false,
      },
    },
    AT,
  );

  assert.equal(payload.userId, "player-42");
  assert.equal(payload.email, "player@contact.example");
  assert.notEqual(payload.email, "provider-reported@steam.example");
  assert.deepEqual(payload, {
    state: "linked",
    provider: "steam",
    providerUserId: "76561198000000000",
    contactId: "contact-1",
    userId: "player-42",
    email: "player@contact.example",
    username: "gaben",
    method: "oauth",
    relink: false,
    version: "7",
    at: "2026-08-14T12:00:00.000Z",
  });
});

test("buildAccountLinkedPayload keeps an above-2^53 version as an exact string", () => {
  const payload = buildAccountLinkedPayload(
    {
      status: "relinked",
      relink: true,
      version: "9007199254740995",
      owner: { contactId: "c", userId: null, email: null },
      previous: {
        contactId: "old",
        version: "9007199254740994",
        owner: { contactId: "old", userId: null, email: null },
      },
      row: {
        id: "row",
        contactId: "c",
        provider: "twitch",
        providerUserId: "u",
        username: null,
        verifiedEmail: null,
        avatarUrl: null,
        method: "oauth",
        singleton: false,
        version: "9007199254740995",
        linkedAt: AT,
        unlinkedAt: null,
        unlinkReason: null,
        tokensRevokedAt: null,
        hasTokens: false,
      },
    },
    AT,
  );

  assert.equal(payload.relink, true);
  assert.equal(JSON.parse(JSON.stringify(payload)).version, "9007199254740995");
});

test("buildAccountUnlinkedPayload reads the contact key and email off the owner block", () => {
  const payload = buildAccountUnlinkedPayload(
    {
      provider: "steam",
      providerUserId: "76561198000000001",
      version: "4",
      reason: "relinked",
      owner: {
        contactId: "loser-contact",
        userId: "anon-abc",
        email: null,
      },
    },
    AT,
  );

  assert.deepEqual(payload, {
    state: "unlinked",
    provider: "steam",
    providerUserId: "76561198000000001",
    // The OWNER block is the single source — never a second contacts lookup
    // at emit time (DECISIONS §15.5).
    contactId: "loser-contact",
    userId: "anon-abc",
    email: null,
    reason: "relinked",
    version: "4",
    at: "2026-08-14T12:00:00.000Z",
  });
});

test("buildLinkFailedPayload carries no version and no state", () => {
  const payload = buildLinkFailedPayload(
    { provider: "steam", reason: "state_invalid", contactId: null },
    AT,
  );

  assert.deepEqual(payload, {
    provider: "steam",
    reason: "state_invalid",
    contactId: null,
    at: "2026-08-14T12:00:00.000Z",
  });
  assert.equal("version" in payload, false);
  assert.equal("state" in payload, false);
});

const STORE_SOURCE = readFileSync(
  fileURLToPath(new URL("./account-links.ts", import.meta.url)),
  "utf8",
);

/**
 * Every symbol that reaches the outbound spine. Naming ONE of these is what
 * the first version of this guard did, and a second emit surface
 * (`emitAccountUnlinked`) walked straight past it.
 */
const EMIT_SYMBOLS = ["emitOutbound", "emitAccountUnlinked"];

/**
 * The store's permitted RUNTIME imports (`import type` is erased, so it cannot
 * carry a call). Anything else — including a THIRD emit helper nobody has
 * written yet, under any name — trips the guard, because emitting requires
 * importing something that can emit.
 *
 * KNOWN LIMIT, stated rather than papered over: this guard reads LITERAL
 * import specifiers and LITERAL symbol names. A store emit routed through both
 * a renamed re-export AND a computed `import(someVariable)` would evade it —
 * source scanning has no fixed point, so the regexes are deliberately not
 * widened. Every single-step variant is caught; if you ever see a non-literal
 * `import(...)` in `lib/account-links.ts`, treat it as the bypass it is rather
 * than as this guard's silence.
 */
const ALLOWED_RUNTIME_IMPORTS = [
  "@hogsend/core",
  "@hogsend/db",
  "drizzle-orm",
  "../env.js",
  "./provider-credentials.js",
];

/** STATIC runtime (non-`import type`) module specifiers. */
function staticImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const m of source.matchAll(
    /^import\s+(?!type\s)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm,
  )) {
    if (m[1]) specifiers.add(m[1]);
  }
  return [...specifiers];
}

/** DYNAMIC `import("…")` module specifiers. */
function dynamicImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    if (m[1]) specifiers.add(m[1]);
  }
  return [...specifiers];
}

/** Runtime (non-`import type`) module specifiers, static and dynamic. */
function runtimeImports(source: string): string[] {
  return [...new Set([...staticImports(source), ...dynamicImports(source)])];
}

test("the store module reaches no emit surface", () => {
  // DECISIONS §15.7: ONE OWNER PER EMIT SITE, and `lib/account-links.ts` is
  // not one of them — it returns facts, its callers emit.
  //
  // This assertion is a SOURCE read rather than a behavioural test on purpose.
  // A store emit PLUS a route emit for the same mutation share the
  // `al:<provider>:<uid>:v<version>` key, so `emitOutbound`'s
  // `onConflictDoNothing({ target: [endpointId, dedupeKey] })` would silently
  // swallow the duplicate: no other test in this repo could fail. The
  // duplicate would just hide which layer owns the fact.
  const hits = STORE_SOURCE.split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => EMIT_SYMBOLS.some((symbol) => line.includes(symbol)));

  assert.deepEqual(
    hits,
    [],
    "lib/account-links.ts must import NEITHER the outbound spine " +
      "(`emitOutbound`) NOR the account-link fan-out helper " +
      `(\`emitAccountUnlinked\`, ./account-link-emit.js); found: ${JSON.stringify(hits)}`,
  );
});

const EMIT_HELPER_SOURCE = readFileSync(
  fileURLToPath(new URL("./account-link-emit.ts", import.meta.url)),
  "utf8",
);

test("the emit helper reaches the spine only by DYNAMIC import", () => {
  // `lib/contacts.ts` imports `account-link-emit.ts`, and `src/testing.ts`
  // re-exports `softDeleteContact` from `lib/contacts.ts`. A STATIC
  // `./hatchet.js` or `./outbound.js` here (outbound →
  // `workflows/deliver-webhook.js` → `lib/hatchet.js`) therefore runs
  // `HatchetClient.init(...)` the instant anything touches the
  // `@hogsend/engine/testing` barrel, which is documented side-effect-free.
  //
  // This is a SOURCE read because NOTHING ELSE CAN CATCH IT. Restoring the
  // static form leaves every gate green — including this package's own suite —
  // because every test environment hands `HATCHET_CLIENT_TOKEN` a well-formed
  // dummy JWT; the throw only appears where the token is malformed or absent,
  // which no gate reproduces. Without this line a simplify pass that dislikes
  // dynamic imports in a loop re-breaks the barrel silently.
  const forbidden = ["./hatchet.js", "./outbound.js"];
  const statics = staticImports(EMIT_HELPER_SOURCE);
  assert.deepEqual(
    statics.filter((s) => forbidden.includes(s)),
    [],
    "lib/account-link-emit.ts must import ./hatchet.js and ./outbound.js " +
      "DYNAMICALLY (inside the fire-and-forget body), never statically: a " +
      "static import runs HatchetClient.init when the side-effect-free " +
      "`@hogsend/engine/testing` barrel is loaded, which throws " +
      `"Invalid token format" without a real token. Found: ${JSON.stringify(statics)}`,
  );

  // And they ARE still reached — a guard that passed because the emit stopped
  // emitting would be worthless.
  const dynamics = dynamicImports(EMIT_HELPER_SOURCE);
  for (const specifier of forbidden) {
    assert.ok(
      dynamics.includes(specifier),
      `lib/account-link-emit.ts no longer dynamically imports ${specifier}`,
    );
  }
});

test("the store module imports nothing new at runtime", () => {
  // The symbol scan above only catches emit surfaces we already know the name
  // of. This one catches the NEXT one: a store that emits has to import
  // something that emits, so pinning the runtime import list makes any such
  // edge fail here first, whatever it gets called.
  assert.deepEqual(
    runtimeImports(STORE_SOURCE).sort(),
    [...ALLOWED_RUNTIME_IMPORTS].sort(),
    "lib/account-links.ts changed its runtime imports. If the new import " +
      "cannot emit (re-read DECISIONS §15.7 — the store returns facts, its " +
      "callers emit), add it to ALLOWED_RUNTIME_IMPORTS.",
  );
});
