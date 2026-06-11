import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, createHogsendClient } from "@hogsend/engine";
import { describe, expect, it } from "vitest";

// The Studio dist is built by `pnpm --filter @hogsend/studio build`. These tests
// only assert the mount BEHAVIOR when a dist is present, so they self-skip when
// the studio hasn't been built (keeps the suite green on a fresh checkout).
const here = dirname(fileURLToPath(import.meta.url));
const studioDist = resolve(here, "../../../../packages/studio/dist");
const studioBuilt = existsSync(resolve(studioDist, "index.html"));

const container = createHogsendClient();
const app = createApp(container);

describe.skipIf(!studioBuilt)("Studio static mount", () => {
  it("serves index.html at /studio/", async () => {
    const res = await app.request("/studio/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<div id="root"');
  });

  it("redirects bare /studio to /studio/", async () => {
    const res = await app.request("/studio");
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toBe("/studio/");
  });

  it("preserves the query string on the /studio prefix redirect", async () => {
    // Regression: better-auth's password-reset link redirects to
    // `/studio?token=…` — dropping the query here stranded users on the
    // login card instead of the reset form.
    const res = await app.request("/studio?token=abc123&foo=bar");
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toBe("/studio/?token=abc123&foo=bar");
  });

  it("falls back to index.html for client-side routes (deep links)", async () => {
    const res = await app.request("/studio/contacts");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<div id="root"');
  });

  it("does NOT shadow the /v1/admin auth guard", async () => {
    // The static mount is public, but the data endpoints stay protected.
    const res = await app.request("/v1/admin/metrics/overview");
    expect(res.status).toBe(401);
  });
});

describe("Studio mount is optional", () => {
  it("does not crash app creation regardless of build state", () => {
    // createApp above already ran mountStudio; reaching here means no throw.
    expect(app).toBeDefined();
  });
});
