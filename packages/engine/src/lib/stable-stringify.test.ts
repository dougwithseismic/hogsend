import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableStringify } from "./stable-stringify.js";

test("sorts keys, drops undefined, handles arrays/primitives/null", () => {
  assert.equal(
    stableStringify({
      type: "property",
      property: "plan",
      operator: "eq",
      value: "pro",
    }),
    '{"operator":"eq","property":"plan","type":"property","value":"pro"}',
  );
  assert.equal(
    stableStringify({ b: 1, a: [2, { d: 3, c: undefined }] }),
    '{"a":[2,{"d":3}],"b":1}',
  );
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify("x"), '"x"');
  assert.equal(stableStringify(7), "7");
});

test("criteriaHash stays byte-identical across the hoist", () => {
  // computeCriteriaHash (workflows/bucket-backfill.ts:45-51) is
  // sha256(stableStringify(criteria ?? null)). This golden pins the MOVED
  // implementation to the pre-hoist bytes: if it ever changes, every
  // bucket_configs.criteriaHash would diff at boot and trigger a re-eval
  // storm. Value computed from the implementation at bucket-backfill.ts
  // BEFORE the move.
  const criteria = {
    type: "property",
    property: "plan",
    operator: "eq",
    value: "pro",
  };
  assert.equal(
    createHash("sha256").update(stableStringify(criteria)).digest("hex"),
    "ac3d4442d5fdb740ba31377346a91a230ab0c14b2c24ef97f74eec08edad3e74",
  );
});
