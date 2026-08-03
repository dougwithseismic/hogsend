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

  it("surfaces the engine's machine error code, never the body", async () => {
    const client = createHttpTenantCredentialClient(async () => {
      return new Response(
        JSON.stringify({
          message: "Invalid origin",
          code: "INVALID_ORIGIN",
          echo: "hunter22222",
        }),
        { status: 403 },
      );
    });

    await expect(
      client.signIn({
        baseUrl: "https://tenant.example.com",
        email: "admin@example.com",
        password: "hunter22222",
      }),
    ).rejects.toThrow("Studio sign-in failed with HTTP 403 (INVALID_ORIGIN)");
  });

  it("keeps the bare status when the body carries no constant-shaped code", async () => {
    const client = createHttpTenantCredentialClient(async () => {
      return new Response(JSON.stringify({ code: "echo hunter22222" }), {
        status: 403,
      });
    });

    await expect(
      client.signIn({
        baseUrl: "https://tenant.example.com",
        email: "admin@example.com",
        password: "hunter22222",
      }),
    ).rejects.toThrow(/failed with HTTP 403$/);
  });
});
