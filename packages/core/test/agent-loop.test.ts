import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { WorkspaceContext } from "@penai/shared";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  StreamEvent,
} from "@penai/providers";
import { createDefaultToolRegistry, ToolRegistry, currentTimeTool } from "@penai/tools";
import {
  appendMessage,
  createDb,
  createSession,
  loadMessages,
  type DbHandle,
} from "@penai/db";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { runAgent, type AgentEvent, type AgentLoopDeps } from "../src/agent-loop.js";

let fx: TestFixtures;
let dbh: DbHandle;

const AGENT = { systemPrompt: "Bạn là trợ lý test.", model: "mock-model", maxIterations: 10 };

function ctx(): WorkspaceContext {
  return { workspaceId: fx.wsA, userId: fx.userId, role: "operator" };
}

/** Provider kịch bản cố định: mỗi lần gọi pop 1 response; ghi lại request. */
class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  private i = 0;
  constructor(private script: ChatResponse[]) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const res = this.script[this.i];
    if (!res) throw new Error("Hết kịch bản");
    this.i += 1;
    return res;
  }
  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await this.chat(req);
    if (response.content) yield { type: "text_delta", text: response.content };
    yield { type: "done", response };
  }
}

const textResponse = (text: string): ChatResponse => ({
  content: text,
  toolCalls: [],
  stopReason: "end",
  usage: { inputTokens: 5, outputTokens: 5 },
});

const toolResponse = (id: string, name: string, args = {}): ChatResponse => ({
  content: null,
  toolCalls: [{ id, name, args }],
  stopReason: "tool_use",
  usage: { inputTokens: 5, outputTokens: 5 },
});

function makeDeps(provider: Provider, tools = createDefaultToolRegistry()): AgentLoopDeps {
  return {
    provider,
    tools,
    workspaceDataDir: ".data/test",
    store: {
      loadMessages: (c, sid) => loadMessages(dbh.db, c, sid),
      appendMessage: (c, sid, input) => appendMessage(dbh.db, c, sid, input),
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function newSession(): Promise<string> {
  const s = await createSession(dbh.db, ctx(), { agentId: fx.agentA });
  return s.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});

afterAll(async () => {
  await dbh.close();
});

describe("Agent loop (spec-agent-loop)", () => {
  it("AC-1: vòng tool call cơ bản + persist đúng thứ tự", async () => {
    const provider = new ScriptedProvider([
      toolResponse("call_1", "current_time"),
      textResponse("Bây giờ là buổi sáng"),
    ]);
    const sessionId = await newSession();
    const events = await collect(
      runAgent(makeDeps(provider), {
        ctx: ctx(),
        agent: AGENT,
        sessionId,
        userMessage: "mấy giờ rồi?",
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.type === "done" && done.finalText).toBe("Bây giờ là buổi sáng");
    expect(done.type === "done" && done.iterations).toBe(1);

    const msgs = await loadMessages(dbh.db, ctx(), sessionId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it("AC-2: tool lỗi không phá vòng lặp", async () => {
    const boom = new ToolRegistry().register(currentTimeTool).register({
      name: "boom",
      description: "luôn lỗi",
      schema: z.object({}),
      async execute() {
        throw new Error("nổ tung");
      },
    });
    const provider = new ScriptedProvider([
      toolResponse("call_1", "boom"),
      textResponse("vẫn ổn"),
    ]);
    const sessionId = await newSession();
    const events = await collect(
      runAgent(makeDeps(provider, boom), {
        ctx: ctx(),
        agent: AGENT,
        sessionId,
        userMessage: "chạy boom đi",
      }),
    );
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult!.type === "tool_result" && toolResult!.isError).toBe(true);
    const done = events.at(-1)!;
    expect(done.type === "done" && done.finalText).toBe("vẫn ổn");
  });

  it("AC-3: max_iterations chặn vòng lặp vô hạn", async () => {
    // Provider luôn đòi gọi tool khi được cấp tools; không có tools → trả text
    const provider: Provider = {
      name: "always-tool",
      async chat(req) {
        return req.tools?.length
          ? toolResponse(`call_${Math.floor(Math.random() * 1e9)}`, "current_time")
          : textResponse("chốt");
      },
      async *chatStream(req) {
        yield { type: "done", response: await this.chat(req) };
      },
    };
    const sessionId = await newSession();
    const events = await collect(
      runAgent(makeDeps(provider), {
        ctx: ctx(),
        agent: { ...AGENT, maxIterations: 3 },
        sessionId,
        userMessage: "lặp đi",
      }),
    );
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(3);
    const done = events.at(-1)!;
    expect(done.type === "done" && done.finalText).toBe("chốt");
    expect(done.type === "done" && done.iterations).toBe(3);
  });

  it("AC-5: lượt sau nhận đủ history (kể cả tool result cũ)", async () => {
    const provider = new ScriptedProvider([
      toolResponse("call_h1", "current_time"),
      textResponse("xong lượt 1"),
      textResponse("xong lượt 2"),
    ]);
    const sessionId = await newSession();
    const deps = makeDeps(provider);
    await collect(
      runAgent(deps, { ctx: ctx(), agent: AGENT, sessionId, userMessage: "lượt 1: mấy giờ?" }),
    );
    await collect(
      runAgent(deps, { ctx: ctx(), agent: AGENT, sessionId, userMessage: "lượt 2" }),
    );

    const lastReq = provider.requests.at(-1)!;
    const roles = lastReq.messages.map((m) => m.role);
    // user(1) → assistant(tool_calls) → tool → assistant(text) → user(2)
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    const toolMsg = lastReq.messages.find((m) => m.role === "tool");
    expect(toolMsg && "toolCallId" in toolMsg && toolMsg.toolCallId).toBe("call_h1");
  });

  it("system prompt: prompt agent → hướng dẫn/ghi nhớ → tri thức → người đang chat; phần lỗi thì bỏ qua", async () => {
    const provider = new ScriptedProvider([textResponse("ok")]);
    const deps: AgentLoopDeps = {
      ...makeDeps(provider),
      buildContextPrefix: async () => "CONTEXT",
      buildKnowledgeContext: async () => {
        throw new Error("vault hỏng");
      },
      buildPersonContext: async () => "# Người đang chat\n- Tên: An",
    };
    const events = await collect(
      runAgent(deps, { ctx: ctx(), agent: AGENT, sessionId: await newSession(), userMessage: "chào" }),
    );
    expect(events.at(-1)!.type).toBe("done");
    expect(provider.requests[0]!.system).toBe(
      "Bạn là trợ lý test.\n\nCONTEXT\n\n# Người đang chat\n- Tên: An",
    );
  });

  it("ảnh tool đưa ra (chụp màn hình trình duyệt) tới mô hình ở vòng sau nhưng không lưu lịch sử", async () => {
    const tools = new ToolRegistry().register({
      name: "chup",
      description: "chụp màn hình giả",
      schema: z.object({}),
      async execute(_args, toolCtx) {
        toolCtx.showImage?.("data:image/jpeg;base64,AAAA");
        const r = await toolCtx.browser?.act({ action: "snapshot" });
        return r?.text ?? "không có trình duyệt";
      },
    });
    const provider = new ScriptedProvider([toolResponse("call_img", "chup"), textResponse("Đã xem ảnh")]);
    const acts: string[] = [];
    const deps: AgentLoopDeps = {
      ...makeDeps(provider, tools),
      browser: {
        act: async (a) => {
          acts.push(a.action);
          return { text: "Trang: Shopee" };
        },
      },
    };
    const sessionId = await newSession();
    const events = await collect(runAgent(deps, { ctx: ctx(), agent: AGENT, sessionId, userMessage: "chụp đi" }));
    expect(events.at(-1)!.type).toBe("done");
    expect(acts).toEqual(["snapshot"]);
    const second = provider.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const toolMsg = second[2]!;
    expect(toolMsg.role === "tool" && toolMsg.content).toBe("Trang: Shopee");
    const imgMsg = second[3]!;
    expect(imgMsg.role === "user" && imgMsg.images).toEqual(["data:image/jpeg;base64,AAAA"]);
    // Ảnh chỉ sống trong lượt chạy: lịch sử DB không có tin "user" giả
    const msgs = await loadMessages(dbh.db, ctx(), sessionId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});
