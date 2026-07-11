/**
 * `send_test_email` — happy path (delivers, returns { status, emailSendId }),
 * a missing template (404 → not_found), and a bad recipient (invalid_input,
 * no network call).
 */
import { describe, expect, it } from "vitest";
import { createSendTestEmailTool } from "../tools/send-test-email.js";
import { httpError, makeClient } from "./helpers.js";

describe("send_test_email", () => {
  it("posts to the send-test route and returns the status", async () => {
    const { client, calls } = makeClient({
      post: () => ({ status: "sent", emailSendId: "es_123" }),
    });
    const tool = createSendTestEmailTool(client);

    const result = (await tool.handler({
      templateKey: "welcome",
      to: "user@example.com",
      props: { name: "Ada" },
    })) as { ok: boolean; status: string; emailSendId?: string };

    expect(result.ok).toBe(true);
    expect(result.status).toBe("sent");
    expect(result.emailSendId).toBe("es_123");
    expect(calls[0]?.path).toBe("/v1/admin/templates/welcome/send-test");
    expect(calls[0]?.body).toEqual({
      to: "user@example.com",
      props: { name: "Ada" },
    });
  });

  it("maps a 404 to not_found", async () => {
    const { client } = makeClient({
      post: () => {
        throw httpError(404, { error: "Template not found" });
      },
    });
    const tool = createSendTestEmailTool(client);

    const result = (await tool.handler({
      templateKey: "ghost",
      to: "user@example.com",
    })) as { ok: boolean; code: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_found");
  });

  it("rejects a malformed recipient without calling the API", async () => {
    const { client, calls } = makeClient({ post: () => ({ status: "sent" }) });
    const tool = createSendTestEmailTool(client);

    const result = (await tool.handler({
      templateKey: "welcome",
      to: "not-an-email",
    })) as { ok: boolean; code: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});
