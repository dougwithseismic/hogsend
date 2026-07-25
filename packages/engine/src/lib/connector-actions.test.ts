import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hogsend/db";
import {
  ConnectorActionRegistry,
  resetConnectorActionRegistry,
  setConnectorActionRegistry,
} from "../connectors/action-registry-singleton.js";
import type {
  DefinedConnectorAction,
  ResolvedActionContact,
} from "../connectors/define-action.js";
import {
  type JourneyBoundary,
  runWithJourneyBoundary,
} from "../journeys/journey-boundary.js";
import {
  type ColdPosture,
  defineContactSource,
} from "../sources/define-contact-source.js";
import {
  buildContactSourceRegistry,
  ContactSourceRegistry,
  setContactSourceRegistry,
} from "../sources/registry.js";
import {
  checkActionAudience,
  sendConnectorAction,
} from "./connector-actions.js";

test("a scoped connector override requires registration validation before capture", async () => {
  let captures = 0;
  const boundary: JourneyBoundary = {
    stateId: "test-state",
    runAnchor: "test-run",
    currentLabel: undefined,
    seenKeys: new Set(),
    seenRecordLabels: new Set(),
    memoize: async (_deps, fn) => fn(),
    services: {
      connector: async () => {
        captures += 1;
        return { delivered: true };
      },
    },
  };

  await assert.rejects(
    runWithJourneyBoundary(boundary, () =>
      sendConnectorAction({
        connectorId: "discord",
        action: "unregistered",
      }),
    ),
    /requires connectorActionExists/,
  );
  assert.equal(captures, 0);
});

// ---------------------------------------------------------------------------
// Cold-channel gate (PRD 05). The engine suite is pure/unit (no DB), so these
// drive `checkActionAudience` directly with a fake preference DB + a fake
// contact resolver; `sendConnectorAction` end-to-end coverage is limited to the
// paths that touch no DB (the no-audience ops action). The gate's placement
// inside the durable memo closure is structural (it runs from `gate()` inside
// `boundary.memoize`) and is not re-derived here.
// ---------------------------------------------------------------------------

/** Fake `Database` serving `readRecipientPreferences` an empty result set. */
function fakePrefDb(rows: unknown[] = []): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as Database;
}

function prospect(source: string | null): ResolvedActionContact {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: "prospect@example.com",
    discordId: null,
    externalId: null,
    source,
    properties: {},
  };
}

/** A member-directed DM action whose `run` counts invocations. */
function memberAction(counter: { runs: number }): DefinedConnectorAction {
  return {
    connectorId: "discord",
    name: "dmMember",
    audience: {
      kind: "member",
      ref: (args) => (args as { ref: string }).ref,
    },
    run: async () => {
      counter.runs += 1;
      return { delivered: true };
    },
  };
}

function claySource(coldPosture?: ColdPosture) {
  return defineContactSource({
    meta: { id: "clay", name: "Clay" },
    auth: { type: "match", header: "x-clay-secret", envKey: "CLAY_SECRET" },
    transform: async () => null,
    ...(coldPosture ? { coldPosture } : {}),
  });
}

/** Install a registry for the test, restoring an empty one afterwards. */
function withSources<T>(
  sources: ReturnType<typeof claySource>[],
  fn: () => Promise<T>,
): Promise<T> {
  buildContactSourceRegistry(sources);
  return fn().finally(() => {
    setContactSourceRegistry(new ContactSourceRegistry());
  });
}

/** Capture stdout (winston Console transport) around `fn`. */
async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: stdout.write overload capture
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(String(chunk));
    return original(chunk, ...rest);
  };
  try {
    const result = await fn();
    // Let winston's stream pipeline flush before restoring.
    await new Promise((resolve) => setImmediate(resolve));
    return { result, output: chunks.join("") };
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore the original writer
    (process.stdout as any).write = original;
  }
}

test("AC1: a prospect from a registered source is blocked on a channel the posture blocks", async () => {
  await withSources([claySource()], async () => {
    const counter = { runs: 0 };
    const action = memberAction(counter);
    const verdict = await checkActionAudience(
      fakePrefDb(),
      async () => prospect("clay"),
      action,
      "discord",
      "dmMember",
      { ref: "prospect@example.com" },
    );
    assert.deepEqual(verdict, {
      skipped: true,
      reason: "cold_channel_blocked",
      connectorId: "discord",
      action: "dmMember",
    });
    // The connector's run was never invoked by the gate.
    assert.equal(counter.runs, 0);
  });
});

test("AC2: the same prospect is allowed on a channel the posture explicitly allows", async () => {
  await withSources([claySource({ discord: "allow" })], async () => {
    const verdict = await checkActionAudience(
      fakePrefDb(),
      async () => prospect("clay"),
      memberAction({ runs: 0 }),
      "discord",
      "dmMember",
      { ref: "prospect@example.com" },
    );
    assert.equal(verdict, null);
  });
});

test("AC3: a contact with a null source is not a prospect and proceeds", async () => {
  await withSources([claySource()], async () => {
    const verdict = await checkActionAudience(
      fakePrefDb(),
      async () => prospect(null),
      memberAction({ runs: 0 }),
      "discord",
      "dmMember",
      { ref: "prospect@example.com" },
    );
    assert.equal(verdict, null);
  });
});

test("AC4: a source not in the registry is not a prospect and proceeds", async () => {
  await withSources([claySource()], async () => {
    const verdict = await checkActionAudience(
      fakePrefDb(),
      async () => prospect("api"),
      memberAction({ runs: 0 }),
      "discord",
      "dmMember",
      { ref: "prospect@example.com" },
    );
    assert.equal(verdict, null);
  });
});

test("AC5: an unresolvable contact fails open (allowed, unchanged)", async () => {
  await withSources([claySource()], async () => {
    const verdict = await checkActionAudience(
      fakePrefDb(),
      async () => null,
      memberAction({ runs: 0 }),
      "discord",
      "dmMember",
      { ref: "nobody@example.com" },
    );
    assert.equal(verdict, null);
  });
});

test("AC6: an ops action (no audience) is never gated — even with prospect sources registered", async () => {
  await withSources([claySource()], async () => {
    // Direct: the gate returns null WITHOUT consulting the resolver.
    let resolves = 0;
    const opsAction: DefinedConnectorAction = {
      connectorId: "discord",
      name: "sendChannelMessage",
      run: async () => ({ messageId: "m1" }),
    };
    const verdict = await checkActionAudience(
      fakePrefDb(),
      async () => {
        resolves += 1;
        return prospect("clay");
      },
      opsAction,
      "discord",
      "sendChannelMessage",
      { channelId: "c1" },
    );
    assert.equal(verdict, null);
    assert.equal(resolves, 0);

    // End-to-end: sendConnectorAction runs the ops action to completion. This
    // path touches no DB (the lazy postgres client never issues a query).
    process.env.DATABASE_URL ??=
      "postgresql://never:connects@localhost:9/never";
    let runs = 0;
    setConnectorActionRegistry(
      new ConnectorActionRegistry([
        {
          connectorId: "discord",
          name: "opsAlert",
          run: async () => {
            runs += 1;
            return { delivered: true };
          },
        },
      ]),
    );
    try {
      const result = await sendConnectorAction({
        connectorId: "discord",
        action: "opsAlert",
        args: { channelId: "c1" },
      });
      assert.deepEqual(result, { delivered: true });
      assert.equal(runs, 1);
    } finally {
      resetConnectorActionRegistry();
    }
  });
});

test("AC7: a cold skip logs once at info with the source id and blocked channel", async () => {
  await withSources([claySource()], async () => {
    const { result, output } = await captureStdout(() =>
      checkActionAudience(
        fakePrefDb(),
        async () => prospect("clay"),
        memberAction({ runs: 0 }),
        "discord",
        "dmMember",
        { ref: "prospect@example.com" },
      ),
    );
    assert.equal(
      (result as { reason?: string } | null)?.reason,
      "cold_channel_blocked",
    );
    const lines = output
      .split("\n")
      .filter((line) => line.includes("cold channel blocked"));
    assert.equal(lines.length, 1, `expected exactly one log line:\n${output}`);
    assert.match(lines[0] as string, /"clay"/);
    assert.match(lines[0] as string, /"discord"/);
  });
});

test("a throwing cold-posture lookup fails open (allowed)", async () => {
  const throwing = new (class extends ContactSourceRegistry {
    override isProspectSource(): boolean {
      throw new Error("registry exploded");
    }
  })();
  setContactSourceRegistry(throwing);
  try {
    const verdict = await checkActionAudience(
      fakePrefDb(),
      async () => prospect("clay"),
      memberAction({ runs: 0 }),
      "discord",
      "dmMember",
      { ref: "prospect@example.com" },
    );
    assert.equal(verdict, null);
  } finally {
    setContactSourceRegistry(new ContactSourceRegistry());
  }
});
