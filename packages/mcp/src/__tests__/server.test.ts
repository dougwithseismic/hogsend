/**
 * Registration smoke test — a real MCP `Client` over a linked in-memory
 * transport pair lists the server's tools, resource, and prompt, and reads the
 * authoring-guide resource and the prompt end-to-end. The admin client is
 * mocked and never touched (listing/reading doesn't call it).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHORING_GUIDE_URI } from "../resources/authoring-guide.js";
import { createHogsendMcpServer } from "../server.js";
import { makeClient } from "./helpers.js";

describe("createHogsendMcpServer registration", () => {
  let client: Client;
  let server: ReturnType<typeof createHogsendMcpServer>;

  beforeEach(async () => {
    const { client: admin } = makeClient({});
    server = createHogsendMcpServer({ client: admin });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("exposes exactly the 3 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hogsend_report",
      "manage_blueprint",
      "send_test_email",
    ]);
  });

  it("exposes the authoring-guide resource and serves its markdown", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(AUTHORING_GUIDE_URI);

    const read = await client.readResource({ uri: AUTHORING_GUIDE_URI });
    const content = read.contents[0];
    expect(content?.mimeType).toBe("text/markdown");
    const text = content && "text" in content ? String(content.text) : "";
    expect(text).toContain("Journey Blueprint authoring guide");
  });

  it("exposes the find_and_fix_bottleneck prompt with its safety contract", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("find_and_fix_bottleneck");

    const prompt = await client.getPrompt({ name: "find_and_fix_bottleneck" });
    const text = prompt.messages
      .map((m) =>
        typeof m.content === "object" && "text" in m.content
          ? m.content.text
          : "",
      )
      .join("\n");
    expect(text).toContain("DRAFT");
    expect(text).toContain("approval");
  });
});
