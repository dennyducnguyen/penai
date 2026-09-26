import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export { UnauthorizedError };

/** Timeout mặc định mỗi lần gọi tool — server treo không được làm treo agent. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Kết quả gọi tool giữ đủ loại content (text + ảnh + link resource). */
export interface McpRichResult {
  text: string;
  images: Array<{ data: Buffer; mime: string }>;
  links: string[];
}

/**
 * Bọc 1 kết nối MCP client. Kết nối tới server (stdio), liệt kê tool, gọi tool.
 * Dùng để đưa tool của MCP server vào ToolRegistry của agent.
 */
export class McpConnection {
  private client: Client;
  private connected = false;

  constructor(readonly serverName: string) {
    this.client = new Client(
      { name: "penai", version: "0.1.0" },
      { capabilities: {} },
    );
  }

  /** Kết nối qua transport tùy ý (stdio thực tế, hoặc in-memory khi test). */
  async connectTransport(transport: Transport): Promise<void> {
    await this.client.connect(transport);
    this.connected = true;
  }

  /** Kết nối tới MCP server chạy dạng subprocess (stdio). */
  async connectStdio(command: string, args: string[], env?: Record<string, string>): Promise<void> {
    const transport = new StdioClientTransport({
      command,
      args,
      ...(env ? { env: { ...process.env as Record<string, string>, ...env } } : {}),
    });
    await this.connectTransport(transport);
  }

  /** Kết nối MCP server qua HTTP streamable (chuẩn mới, ưu tiên). */
  async connectHttp(
    url: string,
    headers?: Record<string, string>,
    authProvider?: OAuthClientProvider,
  ): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      ...(headers ? { requestInit: { headers } } : {}),
      ...(authProvider ? { authProvider } : {}),
    });
    await this.connectTransport(transport);
  }

  /** Kết nối MCP server qua SSE (chuẩn cũ, nhiều server vẫn dùng). */
  async connectSse(
    url: string,
    headers?: Record<string, string>,
    authProvider?: OAuthClientProvider,
  ): Promise<void> {
    const transport = new SSEClientTransport(new URL(url), {
      ...(headers ? { requestInit: { headers } } : {}),
      ...(authProvider ? { authProvider } : {}),
    });
    await this.connectTransport(transport);
  }

  /** Kết nối theo cấu hình transport trong DB. */
  async connect(cfg: {
    transport: string;
    command?: string | null;
    args?: string[];
    url?: string | null;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    authProvider?: OAuthClientProvider;
  }): Promise<void> {
    if (cfg.transport === "stdio") {
      if (!cfg.command) throw new Error("stdio cần command");
      await this.connectStdio(cfg.command, cfg.args ?? [], cfg.env);
      return;
    }
    if (!cfg.url) throw new Error(`${cfg.transport} cần url`);
    if (cfg.transport === "http") {
      await this.connectHttp(cfg.url, cfg.headers, cfg.authProvider);
      return;
    }
    if (cfg.transport === "sse") {
      await this.connectSse(cfg.url, cfg.headers, cfg.authProvider);
      return;
    }
    throw new Error(`Transport chưa hỗ trợ: ${cfg.transport}`);
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<string> {
    const rich = await this.callToolRich(name, args, timeoutMs);
    return rich.text;
  }

  /**
   * Gọi tool và trả đủ các loại content — text ghép lại, ảnh (base64 → Buffer)
   * và link resource tách riêng để caller lưu file / đưa vào transcript.
   * (Trước đây ảnh/resource bị thay bằng "[image]"/"[resource]" và mất nội dung.)
   */
  async callToolRich(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<McpRichResult> {
    // SDK hỗ trợ timeout ở tầng request — server treo sẽ không treo cả lượt chat
    const res = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs,
    });
    const content = res.content as
      | Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
          uri?: string;
          name?: string;
          resource?: { uri?: string; text?: string; mimeType?: string };
        }>
      | undefined;
    const texts: string[] = [];
    const images: McpRichResult["images"] = [];
    const links: string[] = [];
    for (const c of content ?? []) {
      if (c.type === "text") {
        texts.push(c.text ?? "");
      } else if (c.type === "image" && c.data) {
        images.push({ data: Buffer.from(c.data, "base64"), mime: c.mimeType ?? "image/png" });
      } else if (c.type === "resource_link" && c.uri) {
        links.push(c.uri);
        texts.push(`[resource: ${c.name ? `${c.name} — ` : ""}${c.uri}]`);
      } else if (c.type === "resource" && c.resource) {
        if (c.resource.uri) links.push(c.resource.uri);
        if (c.resource.text) texts.push(c.resource.text);
        else texts.push(`[resource: ${c.resource.uri ?? "?"}]`);
      } else {
        texts.push(`[${c.type}]`);
      }
    }
    return { text: texts.join("\n"), images, links };
  }

  /** Ping kiểm tra sống (health check). */
  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (err) {
      // server không hỗ trợ ping vẫn coi là sống
      return /method not found|not supported/i.test((err as Error).message ?? "");
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

/**
 * Đổi authorization code lấy token sau khi người dùng đồng ý trên trang OAuth.
 * Tạo transport đúng loại rồi gọi finishAuth — token được lưu qua provider.saveTokens.
 */
export async function finishMcpAuth(
  cfg: { transport: string; url: string },
  authProvider: OAuthClientProvider,
  code: string,
): Promise<void> {
  const url = new URL(cfg.url);
  const transport =
    cfg.transport === "sse"
      ? new SSEClientTransport(url, { authProvider })
      : new StreamableHTTPClientTransport(url, { authProvider });
  await transport.finishAuth(code);
  await transport.close().catch(() => {});
}
