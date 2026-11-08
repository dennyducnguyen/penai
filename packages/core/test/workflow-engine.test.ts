import { describe, expect, it } from "vitest";
import {
  applyOps,
  diffDefinitions,
  ExprEnv,
  maskSecrets,
  runWorkflow,
  validateDefinition,
  WORKFLOW_TEMPLATES,
  type StepLog,
  type WorkflowDefinition,
  type WorkflowHost,
} from "../src/workflow/index.js";

const TZ = "Asia/Ho_Chi_Minh";

function fakeHost(over: Partial<WorkflowHost> = {}): WorkflowHost & { sent: unknown[]; httpCalls: unknown[] } {
  const sent: unknown[] = [];
  const httpCalls: unknown[] = [];
  return {
    sent,
    httpCalls,
    http: async (req) => {
      httpCalls.push(req);
      return { status: 200, headers: {}, body: { items: [{ kho: "A", total: 100 }, { kho: "B", total: 50 }, { kho: "A", total: 25 }] } };
    },
    send: async (x) => {
      sent.push({ channel: x.channel, to: x.to, text: x.text });
      return { ok: true };
    },
    tool: async (x) => ({ tool: x.tool, args: x.args }),
    mcp: async (x) => ({ server: x.server, tool: x.tool, args: x.args }),
    agent: async (x) => ({ text: `agent ${x.agent}: ${x.message}` }),
    subworkflow: async (x) => ({ sub: x.workflow, inputs: x.inputs }),
    file: async (x) => ({ action: x.action, path: x.path }),
    shell: async () => ({ code: 0, stdout: "" }),
    ...over,
  };
}

const base = (steps: WorkflowDefinition["steps"], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  name: "Thử",
  triggers: [{ type: "manual" }],
  steps,
  ...extra,
});

async function run(def: WorkflowDefinition, opts: Partial<Parameters<typeof runWorkflow>[0]> = {}) {
  const logs: StepLog[] = [];
  const host = (opts.host as ReturnType<typeof fakeHost>) ?? fakeHost();
  const res = await runWorkflow({
    definition: def,
    host,
    trigger: { type: "manual" },
    timezone: TZ,
    onStep: (l) => {
      logs.push(l);
    },
    ...opts,
  });
  return { res, logs, host };
}

describe("biểu thức", () => {
  it("giữ kiểu khi chuỗi chỉ có một {{ }}, ghép chuỗi khi lẫn chữ", async () => {
    const env = await ExprEnv.create({ timezone: TZ });
    env.setGlobal("inputs", { n: 3, ten: "An" });
    expect(env.renderString("{{ inputs.n * 2 }}")).toBe(6);
    expect(env.renderString("Chào {{ inputs.ten }} ({{ inputs.n }})")).toBe("Chào An (3)");
    expect(env.render({ a: "{{ [1,2] }}", b: ["{{ inputs.ten }}"] })).toEqual({ a: [1, 2], b: ["An"] });
    expect(env.evaluate("formatVND(1234567)")).toBe("1.234.567 ₫");
    expect(env.evaluate("groupBy([{k:1},{k:2},{k:1}], 'k').map(g => g.count)")).toEqual([2, 1]);
    expect(env.evaluate("num('1.234.000')")).toBe(1234000);
    expect(String(env.evaluate("today()"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(env.evaluate("typeof fetch + typeof require + typeof process")).toBe("undefinedundefinedundefined");
    env.dispose();
  });

  it("mã chạy vô hạn bị cắt theo thời gian", async () => {
    const env = await ExprEnv.create({ timezone: TZ, timeoutMs: 200 });
    expect(() => env.runCode("while (true) {}")).toThrow(/Quá thời gian/);
    // vẫn dùng tiếp được sau khi bị cắt
    expect(env.evaluate("1 + 1")).toBe(2);
    env.dispose();
  });

  it("biểu thức không sửa được dữ liệu bước trước", async () => {
    const env = await ExprEnv.create({ timezone: TZ });
    env.setStep("a", { output: { x: 1 }, status: "success", durationMs: 0 });
    expect(() => env.runCode("steps.a.output.x = 2; return 1")).toThrow();
    expect(env.evaluate("steps.a.output.x")).toBe(1);
    env.dispose();
  });
});

describe("engine", () => {
  it("chạy ví dụ đầy đủ: http → code → if → loop → send → respond", async () => {
    const def = base([
      { id: "lay_don", type: "http", method: "GET", url: "https://api.example.com/orders?from={{ inputs.ngay }}" },
      { id: "tong_hop", type: "code", code: "const d = steps.lay_don.output.body.items; return { tong: sum(d, 'total'), kho: groupBy(d, 'kho') };" },
      {
        id: "co_don",
        type: "if",
        cond: "steps.tong_hop.output.tong > 0",
        then: [
          {
            id: "tung_kho",
            type: "loop",
            over: "steps.tong_hop.output.kho",
            as: "kho",
            max: 10,
            body: [{ id: "bao_kho", type: "send", channel: "telegram:Bot", to: "123", text: "Kho {{ kho.key }}: {{ kho.count }} đơn" }],
          },
          { id: "tra_loi", type: "respond", status: 201, body: { ok: true, tong: "{{ steps.tong_hop.output.tong }}" } },
        ],
        else: [{ id: "dung", type: "stop", reason: "Không có đơn" }],
      },
    ], { inputs: { ngay: { type: "string", default: "2026-11-07" } } });
    let responded: unknown = null;
    const { res, host, logs } = await run(def, { onRespond: (r: unknown) => (responded = r) } as never);
    expect(res.status).toBe("success");
    expect((host.httpCalls[0] as { url: string }).url).toBe("https://api.example.com/orders?from=2026-11-07");
    expect(host.sent).toEqual([
      { channel: "telegram:Bot", to: "123", text: "Kho A: 2 đơn" },
      { channel: "telegram:Bot", to: "123", text: "Kho B: 1 đơn" },
    ]);
    expect(res.response).toEqual({ status: 201, headers: {}, body: { ok: true, tong: 175 } });
    expect(responded).toEqual(res.response);
    expect(logs.filter((l) => l.stepId === "bao_kho").map((l) => l.iteration)).toEqual([0, 1]);
  });

  it("stop → trạng thái stopped, không phải lỗi", async () => {
    const { res } = await run(base([{ id: "a", type: "code", code: "return 0" }, { id: "b", type: "if", cond: "steps.a.output > 0", then: [], else: [{ id: "s", type: "stop", reason: "hết" }] }]));
    expect(res.status).toBe("stopped");
    expect(res.error).toBe("hết");
  });

  it("retry rồi onError continue", async () => {
    let n = 0;
    const host = fakeHost({
      http: async () => {
        n++;
        throw new Error("mạng lỗi");
      },
    });
    const { res, logs } = await run(
      base([
        { id: "goi", type: "http", url: "https://x.example", retry: { times: 2, delay: "10ms" }, onError: "continue" },
        { id: "sau", type: "code", code: "return steps.goi.error" },
      ]),
      { host },
    );
    expect(n).toBe(3);
    expect(res.status).toBe("success");
    expect(res.output).toBe("mạng lỗi");
    expect(logs.find((l) => l.stepId === "goi")!.attempts).toBe(3);
  });

  it("bước con lỗi → khối cha không chạy lại, quy trình failed", async () => {
    let n = 0;
    const host = fakeHost({
      send: async () => {
        n++;
        throw new Error("kênh lỗi");
      },
    });
    const { res } = await run(
      base([{ id: "khoi", type: "if", cond: "true", retry: { times: 3, delay: "1ms" }, then: [{ id: "g", type: "send", channel: "c", to: "1", text: "x" }] }]),
      { host },
    );
    expect(n).toBe(1);
    expect(res.status).toBe("failed");
    expect(res.error).toContain('Bước "g" lỗi: kênh lỗi');
  });

  it("break, while, switch, set, parallel", async () => {
    const { res } = await run(
      base([
        { id: "dem", type: "set", values: { n: 0 } },
        {
          id: "vong",
          type: "loop",
          over: "range(10)",
          max: 10,
          body: [
            { id: "kt", type: "if", cond: "item >= 3", then: [{ id: "thoat", type: "break" }] },
            { id: "cong", type: "set", values: { n: "{{ vars.n + item }}" } },
          ],
        },
        { id: "w", type: "while", cond: "index < 4", max: 10, body: [{ id: "wb", type: "code", code: "return index * 10" }] },
        {
          id: "chon",
          type: "switch",
          value: "vars.n",
          cases: [
            { value: 2, steps: [{ id: "c2", type: "code", code: "return 'hai'" }] },
            { value: 3, steps: [{ id: "c3", type: "code", code: "return 'ba'" }] },
          ],
          default: [{ id: "cd", type: "code", code: "return 'khác'" }],
        },
        { id: "song_song", type: "parallel", branches: [[{ id: "p1", type: "code", code: "return 1" }], [{ id: "p2", type: "code", code: "return 2" }]] },
        { id: "kq", type: "code", code: "return [vars.n, steps.vong.output.broke, steps.w.output.count, steps.c3.output, steps.song_song.output]" },
      ]),
    );
    expect(res.status).toBe("success");
    expect(res.output).toEqual([3, true, 4, "ba", [1, 2]]);
  });

  it("che khóa bí mật trong nhật ký, không cho dùng secrets ở bước send", async () => {
    const { res, logs, host } = await run(
      base([{ id: "goi", type: "http", url: "https://x.example/?k={{ secrets.KHOA }}", headers: { Authorization: "Bearer {{ secrets.KHOA }}" } }]),
      { secrets: { KHOA: "sieu-bi-mat-123" } },
    );
    expect(res.status).toBe("success");
    expect((host.httpCalls[0] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer sieu-bi-mat-123");
    expect(JSON.stringify(logs)).not.toContain("sieu-bi-mat-123");
    expect(JSON.stringify(logs)).toContain("***");
    const v = await validateDefinition(base([{ id: "g", type: "send", channel: "c", to: "1", text: "{{ secrets.KHOA }}" }]));
    expect(v.ok).toBe(false);
    expect(v.errors[0]!.message).toContain("secrets.* chỉ dùng được");
    expect(maskSecrets({ a: "xx sieu-bi-mat-123" }, ["sieu-bi-mat-123"])).toEqual({ a: "xx ***" });
  });

  it("dry run không gửi tin / không gọi POST", async () => {
    const { res, host, logs } = await run(
      base([
        { id: "dang", type: "http", method: "POST", url: "https://x.example", body: { a: 1 } },
        { id: "gui", type: "send", channel: "c", to: "1", text: "hi" },
      ]),
      { dryRun: true },
    );
    expect(res.status).toBe("success");
    expect(host.httpCalls).toHaveLength(0);
    expect(host.sent).toHaveLength(0);
    expect(logs.map((l) => l.status)).toEqual(["dry_run", "dry_run"]);
  });

  it("quá thời gian chạy tối đa → timeout", async () => {
    const { res } = await run(base([{ id: "cho", type: "wait", duration: "2s" }]), { maxRunMs: 5000 });
    expect(res.status).toBe("success");
    const r2 = await run(
      base([{ id: "goi", type: "http", url: "https://x.example", timeout: 60 }]),
      { maxRunMs: 300, host: fakeHost({ http: () => new Promise(() => {}) }) },
    );
    expect(r2.res.status).toBe("timeout");
  });

  it("bước bị tắt / nhánh không chạy → steps.<id>.output là null, không lỗi", async () => {
    const { res } = await run(
      base([
        { id: "tat", type: "code", code: "return 1", disabled: true },
        { id: "nhanh", type: "if", cond: "false", then: [{ id: "khong_chay", type: "code", code: "return 2" }] },
        { id: "kq", type: "code", code: "return [steps.tat.output, steps.tat.status, steps.khong_chay.output, steps.khong_chay.status]" },
      ]),
    );
    expect(res.status).toBe("success");
    expect(res.output).toEqual([null, "skipped", null, "pending"]);
  });

  it("thiếu tham số bắt buộc → failed rõ ràng", async () => {
    const { res } = await run(base([], { inputs: { sdt: { type: "string", required: true, note: "Số điện thoại" } } }));
    expect(res.status).toBe("failed");
    expect(res.error).toContain('Thiếu tham số bắt buộc "sdt"');
  });

  it("bước agent nhận tin nhắn đã thay biến", async () => {
    const { res } = await run(base([{ id: "hoi", type: "ai", agent: "tro-ly", prompt: "Tóm tắt {{ 1 + 1 }}" } as never]), {});
    // validator đổi ai → agent; engine chạy type agent
    expect(res.status).toBe("failed");
    const v = await validateDefinition(base([{ id: "hoi", type: "ai", agent: "tro-ly", prompt: "Tóm tắt {{ 1 + 1 }}" } as never]));
    const r2 = await run(v.definition);
    expect(r2.res.output).toEqual({ text: "agent tro-ly: Tóm tắt 2" });
  });
});

describe("validator", () => {
  it("báo lỗi có đường dẫn + gợi ý", async () => {
    const v = await validateDefinition(
      base([
        { id: "a", type: "http" },
        { id: "a", type: "code", code: "return (" },
        { id: "x", type: "if", cond: "steps.khong_co > 0", then: [{ id: "g", type: "send", channel: "zalo:nhom-kd", to: "1", text: "x" }] },
        { id: "B", type: "lap" },
      ] as never),
      { catalog: { channels: [{ id: "u1", name: "nhom-kinh-doanh", kind: "zalo", ref: "zalo:nhom-kinh-doanh" }] } },
    );
    const msgs = v.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
    expect(v.ok).toBe(false);
    expect(msgs).toContain("steps[0] (a).url: Thiếu url");
    expect(msgs).toContain('id bước "a" bị trùng');
    expect(msgs).toContain("Lỗi cú pháp JavaScript");
    expect(msgs).toContain('không có bước nào id "khong_co"');
    expect(msgs).toContain("kênh có: zalo:nhom-kinh-doanh");
    expect(msgs).toContain('Loại bước "lap" không có');
  });

  it("mọi mẫu có sẵn đều hợp lệ", async () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const v = await validateDefinition(t.definition);
      expect(v.errors, t.key).toEqual([]);
    }
  });

  it("chuẩn hóa lịch và bỏ trường meta", async () => {
    const v = await validateDefinition({ id: "x", version: 3, name: "a", triggers: [{ type: "schedule", schedule: "every 2h" }], steps: [] });
    expect(v.ok).toBe(true);
    expect("id" in v.definition).toBe(false);
    const bad = await validateDefinition({ name: "a", triggers: [{ type: "schedule", cron: "99 * * * *" }], steps: [] });
    expect(bad.ok).toBe(false);
  });
});

describe("ops + diff", () => {
  const def = base([
    { id: "a", type: "code", code: "return 1" },
    { id: "k", type: "if", cond: "true", then: [{ id: "b", type: "code", code: "return 2" }] },
  ]);
  it("chèn, sửa, di chuyển, xóa", () => {
    const d2 = applyOps(def, [
      { op: "insert", step: { id: "c", type: "code", code: "return 3" }, into: { id: "k", key: "else" } },
      { op: "update_step", id: "a", fields: { name: "Bước A" } },
      { op: "move_step", id: "b", after: "a" },
      { op: "remove_step", id: "c" },
    ]);
    expect(d2.steps.map((s) => s.id)).toEqual(["a", "b", "k"]);
    expect(d2.steps[0]!.name).toBe("Bước A");
    const diff = diffDefinitions(def, d2);
    expect(diff.find((d) => d.id === "a")!.kind).toBe("changed");
    expect(() => applyOps(def, [{ op: "remove_step", id: "zz" }])).toThrow(/Không có bước "zz"/);
  });
});
