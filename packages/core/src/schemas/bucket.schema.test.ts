import { describe, expect, it } from "vitest";
import type { BucketMeta } from "../types/bucket.js";
import { bucketMetaSchema } from "./bucket.schema.js";

/** Minimal well-formed base; each test overrides only what it exercises. */
function meta(overrides: Partial<BucketMeta>): unknown {
  return {
    id: "b1",
    name: "Bucket 1",
    enabled: true,
    ...overrides,
  };
}

/** The `path` of every issue a failed parse produced, joined for assertions. */
function issuePaths(input: unknown): string[] {
  const result = bucketMetaSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe('bucketMetaSchema — kind:"manual"', () => {
  it("accepts a manual bucket with no criteria", () => {
    const result = bucketMetaSchema.safeParse(meta({ kind: "manual" }));
    expect(result.success).toBe(true);
  });

  it("accepts a manual bucket carrying membership-age knobs", () => {
    const result = bucketMetaSchema.safeParse(
      meta({
        kind: "manual",
        entryLimit: "once",
        minDwell: { hours: 1 },
        maxDwell: { hours: 48 },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a manual bucket that declares criteria, on the criteria path", () => {
    const input = meta({
      kind: "manual",
      criteria: {
        type: "property",
        property: "plan",
        operator: "eq",
        value: "pro",
      },
    });
    const result = bucketMetaSchema.safeParse(input);
    expect(result.success).toBe(false);
    // Exactly one issue, and it names `criteria` — not `kind`. A reject that
    // fires on `kind` would be the old blanket "manual is unimplemented" rule
    // rather than the manual+criteria contradiction rule.
    expect(issuePaths(input)).toEqual(["criteria"]);
  });

  it("applies minDwell <= maxDwell to manual buckets, and nothing else", () => {
    const input = meta({
      kind: "manual",
      minDwell: { hours: 48 },
      maxDwell: { hours: 1 },
    });
    const result = bucketMetaSchema.safeParse(input);
    expect(result.success).toBe(false);
    // The coherence check is kind-independent, so it must still fire for a
    // manual bucket — and it must be the ONLY issue, proving `manual` itself
    // is accepted rather than piggy-backing on a blanket manual reject.
    expect(issuePaths(input)).toEqual(["maxDwell"]);
  });

  it("does not apply the dynamic-only rules to a manual bucket", () => {
    // A manual bucket has no criteria, so `criteria` must NOT be demanded of it
    // the way it is of a dynamic bucket.
    expect(bucketMetaSchema.safeParse(meta({ kind: "manual" })).success).toBe(
      true,
    );
    expect(bucketMetaSchema.safeParse(meta({ kind: "dynamic" })).success).toBe(
      false,
    );
  });
});

describe("bucketMetaSchema — dynamic rules are unchanged", () => {
  const positive = {
    type: "property",
    property: "plan",
    operator: "eq",
    value: "pro",
  } as const;

  it("accepts a dynamic bucket with a positive criteria", () => {
    const result = bucketMetaSchema.safeParse(
      meta({ kind: "dynamic", criteria: positive }),
    );
    expect(result.success).toBe(true);
  });

  it("requires criteria when kind is omitted (defaults to dynamic)", () => {
    expect(issuePaths(meta({}))).toEqual(["criteria"]);
  });

  it("rejects pure-negation dynamic criteria", () => {
    expect(
      issuePaths(
        meta({
          kind: "dynamic",
          criteria: {
            type: "property",
            property: "plan",
            operator: "neq",
            value: "pro",
          },
        }),
      ),
    ).toEqual(["criteria"]);
  });

  it("rejects a reserved bucket:* event name in dynamic criteria", () => {
    expect(
      issuePaths(
        meta({
          kind: "dynamic",
          criteria: {
            type: "composite",
            operator: "and",
            conditions: [
              positive,
              { type: "event", eventName: "bucket:entered:x", check: "exists" },
            ],
          },
        }),
      ),
    ).toEqual(["criteria"]);
  });

  it("still enforces minDwell <= maxDwell for dynamic buckets", () => {
    expect(
      issuePaths(
        meta({
          kind: "dynamic",
          criteria: positive,
          minDwell: { hours: 48 },
          maxDwell: { hours: 1 },
        }),
      ),
    ).toEqual(["maxDwell"]);
  });
});
