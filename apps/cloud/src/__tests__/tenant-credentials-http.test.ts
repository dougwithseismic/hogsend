import { describe, expect, it } from "vitest";
import { createHttpTenantCredentialClient } from "../services/tenant-credentials";

/**
 * Better Auth's CSRF guard refuses a request carrying no Origin at all
 * (`403 MISSING_OR_NULL_ORIGIN`), and a server-to-server fetch sends none by
 * default. That 403 parked a healthy tenant stack in production, and read as a
 * wrong password until the response BODY was read. Pin the header.
 */
describe("http tenant credential client", () => {
  it("names the instance's own origin on sign-in", async () => {
    let seen: Headers | undefined;
    const client = createHttpTenantCredentialClient(async (_url, init) => {
      seen = new Headers(init?.headers);
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": "session=abc; Path=/" },
      });
    });

    await client.signIn({
      baseUrl: "https://tenant.example.com/",
      email: "admin@example.com",
      password: "hunter22222",
    });

    expect(seen?.get("origin")).toBe("https://tenant.example.com");
  });
});
