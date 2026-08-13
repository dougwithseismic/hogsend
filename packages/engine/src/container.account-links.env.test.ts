import assert from "node:assert/strict";
import test from "node:test";

// The env-var leg of the allowlist merge needs ACCOUNT_LINK_ALLOWED_ORIGINS
// SET at env-parse time, and t3-env parses process.env exactly once per
// import — so this case lives in its own file (its own node:test process),
// exactly the email-provider-boot.hogsend.test.ts split. Env is set BEFORE
// the container import; see container.account-links.test.ts for the rest of
// the boot preconditions.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
process.env.ACCOUNT_LINK_ALLOWED_ORIGINS =
  "https://env-a.example.com, https://env-b.example.com";

const { createHogsendClient } = await import("./container.js");

test("parses ACCOUNT_LINK_ALLOWED_ORIGINS and the option into one list, env first", () => {
  const client = createHogsendClient({
    accountLinks: {
      allowedOrigins: [
        "https://option.example.com",
        // Duplicate of an env entry — deduped, first (env) position kept.
        "https://env-a.example.com",
      ],
    },
  });
  assert.deepEqual(client.accountLinkAllowedOrigins, [
    "https://env-a.example.com",
    "https://env-b.example.com",
    "https://option.example.com",
  ]);
});
