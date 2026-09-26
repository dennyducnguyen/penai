import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAccountManager, CodexProvider, type CodexAuth } from "../src/index.js";

function fakeAuth(id: string, email?: string): CodexAuth {
  return {
    accessToken: "at-" + id,
    refreshToken: "rt-" + id,
    idToken: "id-" + id,
    accountId: id,
    ...(email ? { email } : {}),
    expiresAt: Date.now() + 3600_000,
  };
}

let dir: string;
let legacyFile: string;
let accountsDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "penai-codex-"));
  legacyFile = join(dir, "codex-auth.json");
  accountsDir = join(dir, "accounts");
});

describe("CodexAccountManager — nạp & thêm tài khoản", () => {
  it("nạp file legacy làm tài khoản 'chinh' + các file trong accountsDir", async () => {
    await writeFile(legacyFile, JSON.stringify(fakeAuth("acc-1", "a@x.com")));
    await mkdir(accountsDir, { recursive: true });
    await writeFile(join(accountsDir, "b-x-com.json"), JSON.stringify(fakeAuth("acc-2", "b@x.com")));
    const m = new CodexAccountManager(legacyFile, accountsDir);
    const list = m.list();
    expect(list.map((a) => a.alias).sort()).toEqual(["b-x-com", "chinh"]);
    expect(list.every((a) => a.status === "ready")).toBe(true);
  });

  it("addAccount: tài khoản mới lưu vào accountsDir với alias từ email", () => {
    const m = new CodexAccountManager(legacyFile, accountsDir);
    const acc = m.addAccount(fakeAuth("acc-9", "Team.Sales@Company.vn"));
    expect(acc.alias).toBe("team-sales-company-vn");
    expect(existsSync(join(accountsDir, "team-sales-company-vn.json"))).toBe(true);
  });

  it("addAccount trùng accountId → cập nhật tại chỗ, không nhân bản", async () => {
    await writeFile(legacyFile, JSON.stringify(fakeAuth("acc-1", "a@x.com")));
    const m = new CodexAccountManager(legacyFile, accountsDir);
    m.load();
    const before = m.size();
    m.addAccount(fakeAuth("acc-1", "a@x.com"));
    expect(m.size()).toBe(before);
  });

  it("file trong accountsDir trùng accountId với legacy → bỏ qua khi nạp", async () => {
    await writeFile(legacyFile, JSON.stringify(fakeAuth("acc-1", "a@x.com")));
    await mkdir(accountsDir, { recursive: true });
    await writeFile(join(accountsDir, "dup.json"), JSON.stringify(fakeAuth("acc-1", "a@x.com")));
    const m = new CodexAccountManager(legacyFile, accountsDir);
    expect(m.size()).toBe(1);
  });

  it("removeAccount xóa khỏi pool + xóa file", () => {
    const m = new CodexAccountManager(legacyFile, accountsDir);
    const acc = m.addAccount(fakeAuth("acc-5", "c@x.com"));
    expect(m.removeAccount(acc.alias)).toBe(true);
    expect(m.size()).toBe(0);
    expect(existsSync(join(accountsDir, acc.alias + ".json"))).toBe(false);
  });
});

describe("CodexAccountManager — chọn tài khoản xoay vòng", () => {
  function poolOf3(): CodexAccountManager {
    const m = new CodexAccountManager(legacyFile, accountsDir);
    m.addAccount(fakeAuth("a1", "a1@x.com"));
    m.addAccount(fakeAuth("a2", "a2@x.com"));
    m.addAccount(fakeAuth("a3", "a3@x.com"));
    return m;
  }

  it("ưu tiên tài khoản ít việc đang chạy nhất", () => {
    const m = poolOf3();
    const [first] = m.pickOrder();
    m.acquire(first!.alias);
    m.acquire(first!.alias);
    const next = m.pickOrder()[0]!;
    expect(next.alias).not.toBe(first!.alias);
    expect(next.inFlight).toBe(0);
  });

  it("hòa in-flight thì xoay vòng — 3 lần chọn liên tiếp ra 3 tài khoản khác nhau", () => {
    const m = poolOf3();
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) seen.add(m.pickOrder()[0]!.alias);
    expect(seen.size).toBe(3);
  });

  it("tài khoản nghẽn (markThrottled) bị đẩy xuống cuối; hết cooldown thì trở lại", () => {
    const m = poolOf3();
    const target = m.pickOrder()[0]!.alias;
    m.markThrottled(target, 60_000);
    for (let i = 0; i < 5; i++) {
      const order = m.pickOrder();
      expect(order[0]!.alias).not.toBe(target);
      // vẫn nằm cuối danh sách (phòng khi mọi tài khoản đều nghẽn)
      expect(order[order.length - 1]!.alias).toBe(target);
    }
    m.markOk(target);
    const aliases = m.pickOrder().slice(0, 3).map((s) => s.alias);
    expect(aliases).toContain(target);
  });

  it("cooldown lũy tiến: streak tăng thì nghỉ lâu hơn, markOk reset", () => {
    const m = poolOf3();
    const a = m.pickOrder()[0]!.alias;
    m.markThrottled(a);
    const s1 = m.list().find((x) => x.alias === a)!;
    expect(s1.status).toBe("cooldown");
    expect(s1.cooldownSeconds).toBeLessThanOrEqual(60);
    m.markThrottled(a);
    const s2 = m.list().find((x) => x.alias === a)!;
    expect(s2.cooldownSeconds).toBeGreaterThan(60);
    m.markOk(a);
    expect(m.list().find((x) => x.alias === a)!.status).toBe("ready");
  });

  it("markThrottled tôn trọng Retry-After lớn hơn backoff", () => {
    const m = poolOf3();
    const a = m.pickOrder()[0]!.alias;
    m.markThrottled(a, 10 * 60_000);
    const s = m.list().find((x) => x.alias === a)!;
    expect(s.cooldownSeconds).toBeGreaterThan(9 * 60);
  });

  it("needs_reauth bị loại hẳn khỏi vòng xoay", () => {
    const m = poolOf3();
    const a = m.pickOrder()[0]!.alias;
    m.markNeedsReauth(a);
    for (let i = 0; i < 6; i++) {
      expect(m.pickOrder().every((s) => s.alias !== a)).toBe(true);
    }
    expect(m.list().find((x) => x.alias === a)!.status).toBe("needs_reauth");
  });

  it("mọi tài khoản đều nghẽn → vẫn trả về theo thứ tự hết cooldown sớm nhất", () => {
    const m = poolOf3();
    const order0 = m.pickOrder().map((s) => s.alias);
    m.markThrottled(order0[0]!, 30_000);
    m.markThrottled(order0[1]!, 10_000);
    m.markThrottled(order0[2]!, 20_000);
    const order = m.pickOrder().map((s) => s.alias);
    expect(order[0]).toBe(order0[1]); // hết cooldown sớm nhất đứng đầu
    expect(order.length).toBe(3);
  });

  it("acquire/release đếm in-flight đúng, không âm", () => {
    const m = poolOf3();
    const a = m.pickOrder()[0]!.alias;
    m.acquire(a);
    m.acquire(a);
    m.release(a);
    m.release(a);
    m.release(a); // thừa — không được âm
    expect(m.list().find((x) => x.alias === a)!.inFlight).toBe(0);
  });
});

describe("CodexProvider — failover trong cùng request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sseBody(events: unknown[]): AsyncIterable<Uint8Array> {
    const enc = new TextEncoder();
    return (async function* () {
      for (const ev of events) {
        yield enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
      }
      yield enc.encode("data: [DONE]\n\n");
    })();
  }

  it("tài khoản 1 dính 429 → cooldown + request chuyển ngay sang tài khoản 2", async () => {
    await mkdir(accountsDir, { recursive: true });
    await writeFile(join(accountsDir, "a1.json"), JSON.stringify(fakeAuth("a1", "a1@x.com")));
    await writeFile(join(accountsDir, "a2.json"), JSON.stringify(fakeAuth("a2", "a2@x.com")));
    const p = new CodexProvider("codex", { authFile: legacyFile, accountsDir });

    const calledAccounts: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: { headers: Record<string, string> }) => {
      const acct = init.headers["chatgpt-account-id"];
      calledAccounts.push(acct!);
      if (acct === "a1") {
        return {
          ok: false,
          status: 429,
          body: null,
          headers: new Headers({ "retry-after": "120" }),
          text: async () => "quota exhausted",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: sseBody([
          { type: "response.output_text.delta", delta: "xin chào" },
          {
            type: "response.completed",
            response: { output: [], usage: { input_tokens: 5, output_tokens: 2 } },
          },
        ]),
      };
    });

    const res = await p.chat({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("xin chào");
    expect(calledAccounts).toEqual(["a1", "a2"]);

    const accs = p.listAccounts();
    const a1 = accs.find((a) => a.accountId === "a1")!;
    expect(a1.status).toBe("cooldown");
    expect(a1.cooldownSeconds).toBeGreaterThan(100); // tôn trọng Retry-After 120s
    expect(accs.find((a) => a.accountId === "a2")!.status).toBe("ready");
  });

  it("chat() không stream: backend đóng socket giữa SSE ('terminated') → retry từ đầu và thành công", async () => {
    await writeFile(legacyFile, JSON.stringify(fakeAuth("t1", "t1@x.com")));
    const p = new CodexProvider("codex", { authFile: legacyFile, accountsDir });
    const enc = new TextEncoder();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: (async function* () {
            yield enc.encode(
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "cụt" })}\n\n`,
            );
            throw new TypeError("terminated");
          })(),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: sseBody([
          { type: "response.output_text.delta", delta: "đầy đủ" },
          {
            type: "response.completed",
            response: { output: [], usage: { input_tokens: 3, output_tokens: 2 } },
          },
        ]),
      };
    });
    const res = await p.chat({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    expect(res.content).toBe("đầy đủ"); // không lẫn phần cụt của lượt hỏng
    expect(calls).toBe(2);
  });

  it("chatStream: đã phát chữ ra ngoài rồi đứt → KHÔNG retry (tránh lặp nội dung)", async () => {
    await writeFile(legacyFile, JSON.stringify(fakeAuth("t2", "t2@x.com")));
    const p = new CodexProvider("codex", { authFile: legacyFile, accountsDir });
    const enc = new TextEncoder();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: (async function* () {
          yield enc.encode(
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "a" })}\n\n`,
          );
          throw new TypeError("terminated");
        })(),
      };
    });
    const consume = async () => {
      for await (const _ev of p.chatStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // bỏ qua
      }
    };
    await expect(consume()).rejects.toThrow(/terminated/);
    expect(calls).toBe(1);
  });

  it("mọi tài khoản đều lỗi → ném lỗi cuối, không treo", async () => {
    await mkdir(accountsDir, { recursive: true });
    await writeFile(join(accountsDir, "b1.json"), JSON.stringify(fakeAuth("b1")));
    await writeFile(join(accountsDir, "b2.json"), JSON.stringify(fakeAuth("b2")));
    const p = new CodexProvider("codex", { authFile: legacyFile, accountsDir });
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 429,
      body: null,
      headers: new Headers(),
      text: async () => "quota",
    }));
    await expect(
      p.chat({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/429/);
    expect(p.listAccounts().every((a) => a.status === "cooldown")).toBe(true);
  });
});
