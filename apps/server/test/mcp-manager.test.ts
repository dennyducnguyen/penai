import { describe, expect, it } from "vitest";
import type { EnabledMcpServer } from "@penai/db";
import { McpManager, parseEnv, type McpConnectionLike } from "../src/mcp-manager.js";

function fakeConn(opts: {
  tools?: string[];
  pingResult?: () => boolean;
  onConnect?: () => void;
}): McpConnectionLike {
  return {
    connect: async () => {
      opts.onConnect?.();
    },
    listTools: async () =>
      (opts.tools ?? []).map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {} },
      })),
    callTool: async () => "ok",
    ping: async () => (opts.pingResult ? opts.pingResult() : true),
    close: async () => {},
  };
}

function srv(over: Partial<EnabledMcpServer> = {}): EnabledMcpServer {
  return {
    id: "sv-1",
    workspaceId: "ws-1",
    name: "may-chu",
    transport: "stdio",
    command: "cmd",
    args: [],
    url: null,
    envEncrypted: null,
    visibility: "workspace",
    oauthEncrypted: null,
    ...over,
  };
}

describe("McpManager: phân quyền tool theo agent", () => {
  it("visibility=workspace: agent nào cũng thấy; không rõ agent vẫn thấy", async () => {
    const mgr = new McpManager({
      connectionFactory: () => fakeConn({ tools: ["read_file", "write_file"] }),
    });
    await mgr.connectServer(srv());
    // không rõ agent (access=undefined) → server workspace vẫn dùng được
    expect(mgr.toolsFor("ws-1").map((t) => t.name)).toEqual([
      "mcp__may-chu__read_file",
      "mcp__may-chu__write_file",
    ]);
  });

  it("visibility=granted: không rõ agent → ẩn; có access map → lọc theo tool_allow", async () => {
    const mgr = new McpManager({
      connectionFactory: () => fakeConn({ tools: ["read_file", "write_file"] }),
    });
    await mgr.connectServer(srv({ visibility: "granted" }));

    // không rõ agent → fail-closed
    expect(mgr.toolsFor("ws-1")).toEqual([]);
    // agent không có grant → rỗng
    expect(mgr.toolsFor("ws-1", new Map())).toEqual([]);
    // grant full (allow=null) → mọi tool
    expect(mgr.toolsFor("ws-1", new Map([["sv-1", { allow: null }]]))).toHaveLength(2);
    // tool_allow chỉ read_file
    const filtered = mgr.toolsFor(
      "ws-1",
      new Map([["sv-1", { allow: new Set(["read_file"]) }]]),
    );
    expect(filtered.map((t) => t.name)).toEqual(["mcp__may-chu__read_file"]);
    // deny luôn thắng — kể cả khi allow=null (mọi tool)
    const denied = mgr.toolsFor(
      "ws-1",
      new Map([["sv-1", { allow: null, deny: new Set(["write_file"]) }]]),
    );
    expect(denied.map((t) => t.name)).toEqual(["mcp__may-chu__read_file"]);
    // deny thắng cả tool nằm trong allow
    const denyWins = mgr.toolsFor(
      "ws-1",
      new Map([
        ["sv-1", { allow: new Set(["read_file", "write_file"]), deny: new Set(["read_file"]) }],
      ]),
    );
    expect(denyWins.map((t) => t.name)).toEqual(["mcp__may-chu__write_file"]);
  });

  it("xóa server → tool biến mất, health loop không thử lại", async () => {
    const mgr = new McpManager({
      connectionFactory: () => fakeConn({ tools: ["a"] }),
    });
    await mgr.connectServer(srv());
    expect(mgr.toolsFor("ws-1")).toHaveLength(1);
    await mgr.removeServer("sv-1");
    expect(mgr.toolsFor("ws-1")).toEqual([]);
    expect(mgr.statusOf("sv-1")).toBeUndefined();
  });
});

describe("McpManager: health check + tự kết nối lại", () => {
  it("ping hỏng 3 lần liên tiếp → tự kết nối lại", async () => {
    let connects = 0;
    let alive = true;
    const mgr = new McpManager({
      connectionFactory: () =>
        fakeConn({
          tools: ["t"],
          pingResult: () => alive,
          onConnect: () => {
            connects++;
          },
        }),
    });
    await mgr.connectServer(srv());
    expect(connects).toBe(1);

    alive = false; // server "chết": ping fail nhưng connect lại vẫn OK (fake)
    await mgr.healthTick(); // fail 1
    await mgr.healthTick(); // fail 2
    expect(mgr.statusOf("sv-1")?.connected).toBe(true); // chưa tới ngưỡng
    await mgr.healthTick(); // fail 3 → disconnect → reconnect ngay trong tick
    expect(connects).toBe(2);
    expect(mgr.statusOf("sv-1")?.connected).toBe(true);
    alive = true;
    await mgr.healthTick(); // ping OK trở lại → giữ kết nối, không reconnect thêm
    expect(connects).toBe(2);
  });

  it("server hỏng liên tục → backoff, không thử dồn dập", async () => {
    let connects = 0;
    const mgr = new McpManager({
      connectionFactory: () =>
        fakeConn({
          tools: [],
          onConnect: () => {
            connects++;
            throw new Error("hỏng hoài");
          },
        }),
    });
    const t0 = Date.now();
    await mgr.connectServer(srv());
    expect(mgr.statusOf("sv-1")?.connected).toBe(false);
    expect(connects).toBe(1);

    await mgr.healthTick(t0); // lần thử 1 → backoff 2s
    expect(connects).toBe(2);
    await mgr.healthTick(t0 + 1_000); // chưa hết backoff → không thử
    expect(connects).toBe(2);
    await mgr.healthTick(t0 + 3_000); // hết backoff → thử lần 2
    expect(connects).toBe(3);
  });
});

describe("parseEnv", () => {
  it("tách theo dòng, giá trị chứa ';' không bị cắt", () => {
    const env = parseEnv("A=1\nCONN=host=x;port=5432\n# chú thích\nB = hai ");
    expect(env).toEqual({ A: "1", CONN: "host=x;port=5432", B: "hai" });
  });
  it("fallback tách bằng ';' khi 1 dòng", () => {
    expect(parseEnv("A=1;B=2")).toEqual({ A: "1", B: "2" });
  });
});
