import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch } from "./fake-fetch.js";
import steamFixtures from "./steam.json" with { type: "json" };

test("records calls with method, headers and body", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST https://id.twitch.tv/oauth2/token": {
      body: { access_token: "fixture-token" },
    },
  });

  const response = await fetchImpl("https://id.twitch.tv/oauth2/token?x=1", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code" }).toString(),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: "fixture-token" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "POST");
  // The full URL (query included) is recorded even though the route key
  // strips the query — tests assert params off `calls`.
  assert.equal(calls[0]?.url, "https://id.twitch.tv/oauth2/token?x=1");
  assert.equal(
    calls[0]?.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(calls[0]?.body, "grant_type=authorization_code");
});

test("throws on an unmatched route", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  await assert.rejects(
    () =>
      fetchImpl("https://evil.example.com/openid/login", { method: "POST" }),
    /no route registered for "POST https:\/\/evil\.example\.com\/openid\/login"/,
  );
  // The call is still recorded, so a test can see WHAT reached out.
  assert.equal(calls.length, 1);
});

test("serves a text body for the steam check_authentication route", async () => {
  const { fetchImpl } = fakeFetch({
    "POST https://steamcommunity.com/openid/login": {
      text: steamFixtures.checkAuthenticationValid,
    },
  });
  const response = await fetchImpl("https://steamcommunity.com/openid/login", {
    method: "POST",
    body: "openid.mode=check_authentication",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(await response.text(), /^is_valid:true$/m);
});
