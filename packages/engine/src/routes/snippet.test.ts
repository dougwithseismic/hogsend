import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { secureHeaders } from "hono/secure-headers";
import { loadSnippet } from "../lib/snippet.js";
import {
  createSnippetRouter,
  SNIPPET_CACHE_CONTROL,
  SNIPPET_PATH,
} from "./snippet.js";

// Mirrors app.ts: secureHeaders on everything EXCEPT the snippet path (it
// would force CORP same-origin after the handler and break the embed).
function appWith(path: string | null) {
  const app = new OpenAPIHono();
  const secure = secureHeaders();
  app.use("*", (c, next) =>
    c.req.path === SNIPPET_PATH ? next() : secure(c, next),
  );
  app.route("/", createSnippetRouter(loadSnippet(path)));
  return app;
}

function tmpSnippet(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "hs-snippet-"));
  const file = join(dir, "hogsend.js");
  writeFileSync(file, body);
  return file;
}

test("serves the snippet with cache + cross-origin headers", async () => {
  const app = appWith(tmpSnippet("console.log('hi')"));
  const res = await app.request("/hogsend.js");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "console.log('hi')");
  assert.equal(
    res.headers.get("content-type"),
    "application/javascript; charset=utf-8",
  );
  assert.equal(res.headers.get("cache-control"), SNIPPET_CACHE_CONTROL);
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.match(res.headers.get("etag") ?? "", /^"[a-f0-9]{32}"$/);
});

test("revalidates to 304 on a matching If-None-Match", async () => {
  const app = appWith(tmpSnippet("x"));
  const first = await app.request("/hogsend.js");
  const etag = first.headers.get("etag") ?? "";
  const res = await app.request("/hogsend.js", {
    headers: { "if-none-match": etag },
  });
  assert.equal(res.status, 304);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("etag"), etag);
});

test("etag tracks content", () => {
  const a = loadSnippet(tmpSnippet("a"));
  const b = loadSnippet(tmpSnippet("b"));
  assert.notEqual(a?.etag, b?.etag);
});

test("404s when no asset is installed", async () => {
  const app = appWith(null);
  const res = await app.request("/hogsend.js");
  assert.equal(res.status, 404);
});
