import assert from "node:assert/strict";
import test from "node:test";
import {
  type JourneyBoundary,
  runWithJourneyBoundary,
} from "../journeys/journey-boundary.js";
import { sendConnectorAction } from "./connector-actions.js";

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
