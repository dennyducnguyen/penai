import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpConnection } from "../src/client.js";

describe("MCP client (in-memory server)", () => {
  it("kết nối, liệt kê tool, gọi tool", async () => {
    // Server MCP tối giản với 1 tool "add"
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    server.tool(
      "add",
      "Cộng hai số",
      { a: z.number(), b: z.number() },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const conn = new McpConnection("test-server");
    await conn.connectTransport(clientTransport);

    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toContain("add");
    expect(tools[0]!.inputSchema).toHaveProperty("properties");

    const result = await conn.callTool("add", { a: 2, b: 5 });
    expect(result).toBe("7");

    await conn.close();
  });
});
