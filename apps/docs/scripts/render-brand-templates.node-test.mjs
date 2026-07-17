import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAlphaSummary,
  createRenderJobs,
  INTERCEPTED_ROUTES,
  jobKey,
  outputRelativePath,
  parseRenderArguments,
  pngMetadata,
  thumbnailDimensions,
} from "./render-brand-templates.mjs";

test("the renderer isolates previews from unrelated root-provider APIs", () => {
  assert.deepEqual(INTERCEPTED_ROUTES, [
    "**/api/auth/get-session",
    "**/api/posthog-config",
  ]);
});

test("createRenderJobs defines 92 unique template and content exports", () => {
  const jobs = createRenderJobs();
  assert.equal(jobs.length, 92);
  assert.equal(new Set(jobs.map(jobKey)).size, 92);
  assert.equal(jobs.filter(({ kind }) => kind === "template").length, 50);
  assert.equal(jobs.filter(({ kind }) => kind === "example").length, 6);
  assert.equal(jobs.filter(({ kind }) => kind === "campaign").length, 36);
  assert.equal(
    jobs.filter(({ treatment }) => treatment === "colorway").length,
    20,
  );
  assert.ok(
    jobs.some(
      (job) =>
        job.preset === "linkedin-company-banner" &&
        job.width === 4200 &&
        job.height === 700,
    ),
  );
});

test("outputRelativePath organizes templates, examples, and campaigns", () => {
  assert.equal(
    outputRelativePath({
      preset: "youtube-thumbnail",
      treatment: "signed",
      palette: "default",
    }),
    "signed/youtube-thumbnail--signed.png",
  );
  assert.equal(
    outputRelativePath({
      preset: "social-square",
      treatment: "colorway",
      palette: "cyan",
    }),
    "colorways/cyan/social-square--cyan.png",
  );
  assert.equal(
    outputRelativePath({
      preset: "stream-overlay",
      treatment: "clean",
      palette: "default",
    }),
    "stream/stream-overlay--clean.png",
  );
  assert.equal(
    outputRelativePath({ kind: "example", example: "og-product-logic" }),
    "examples/og-product-logic.png",
  );
  assert.equal(
    outputRelativePath({
      kind: "campaign",
      platform: "reddit",
      variant: "silent-drift",
      card: 2,
      role: "action",
    }),
    "campaigns/reddit/silent-drift/02-action.png",
  );
});

test("parseRenderArguments filters jobs and validates combinations", () => {
  const all = parseRenderArguments([]);
  assert.equal(all.jobs.length, 92);
  assert.equal(all.desktop, false);

  const filtered = parseRenderArguments([
    "--preset",
    "social-square",
    "--treatment",
    "colorway",
    "--palette",
    "violet",
    "--desktop",
  ]);
  assert.equal(filtered.desktop, true);
  assert.deepEqual(filtered.jobs.map(jobKey), [
    "template:social-square:colorway:violet",
  ]);

  assert.deepEqual(
    parseRenderArguments([
      "--kind",
      "example",
      "--example",
      "og-product-logic",
    ]).jobs.map(jobKey),
    ["example:og-product-logic"],
  );
  assert.deepEqual(
    parseRenderArguments([
      "--platform",
      "reddit",
      "--variant",
      "silent-drift",
      "--card",
      "2",
    ]).jobs.map(jobKey),
    ["campaign:reddit:silent-drift:2"],
  );

  assert.throws(
    () => parseRenderArguments(["--preset", "unknown"]),
    /Unknown brand template preset: unknown/,
  );
  assert.throws(
    () =>
      parseRenderArguments(["--preset", "story", "--treatment", "colorway"]),
    /No render jobs match/,
  );
  assert.throws(
    () => parseRenderArguments(["--kind", "campaign", "--example", "missing"]),
    /No render jobs match/,
  );
  assert.throws(
    () => parseRenderArguments(["--card", "0"]),
    /No render jobs match/,
  );
});

test("pngMetadata reads dimensions and colour type from IHDR", () => {
  const png = Buffer.alloc(26);
  png[0] = 0x89;
  png.write("PNG", 1, "ascii");
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  png[25] = 6;

  assert.deepEqual(pngMetadata(png), {
    width: 1920,
    height: 1080,
    colorType: 6,
  });
  assert.throws(() => pngMetadata(Buffer.from("not png")), /not a PNG/);
});

test("thumbnailDimensions bounds large source images without distortion", () => {
  assert.deepEqual(thumbnailDimensions(4200, 700), {
    width: 340,
    height: 57,
  });
  assert.deepEqual(thumbnailDimensions(1080, 1920), {
    width: 107,
    height: 190,
  });
  assert.deepEqual(thumbnailDimensions(1080, 1080), {
    width: 190,
    height: 190,
  });
});

test("assertAlphaSummary enforces opaque posts and transparent stream centers", () => {
  assert.doesNotThrow(() =>
    assertAlphaSummary("og", { centerAlpha: 255, edgeAlpha: 255 }),
  );
  assert.doesNotThrow(() =>
    assertAlphaSummary("stream-overlay", {
      centerAlpha: 0,
      edgeAlpha: 120,
    }),
  );
  assert.throws(
    () =>
      assertAlphaSummary("stream-overlay", {
        centerAlpha: 255,
        edgeAlpha: 255,
      }),
    /center must be fully transparent/,
  );
  assert.throws(
    () =>
      assertAlphaSummary("stream-overlay", {
        centerAlpha: 0,
        edgeAlpha: 0,
      }),
    /edges must contain visible pixels/,
  );
});
