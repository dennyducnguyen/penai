import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatProvider } from "../src/openai-compat.js";
import {
  HoiaiProvider,
  hoiaiDevicePoll,
  hoiaiDeviceStart,
  hoiaiImageBackend,
} from "../src/hoiai.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** HoiAI giả theo đặc tả: /models có type + input_modalities, device flow, /me, ảnh. */
interface Seen {
  method: string;
  path: string;
  auth?: string;
  body: Record<string, unknown> | null;
}
let seen: Seen[] = [];
let tokenCalls = 0;
let server: Server;
let base = "";

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = (req.url ?? "").replace(/^\/api\/v1/, "");
    const body = await readBody(req);
    seen.push({ method: req.method ?? "", path, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
    const authed = req.headers.authorization === "Bearer hk_live_test";
    if (path === "/oauth/device/code") {
      return send(res, 200, {
        device_code: "dc_1",
        user_code: "ABCD-1234",
        verification_uri: "https://chat.hoiai.vn/kich-hoat",
        expires_in: 600,
        interval: 5,
      });
    }
    if (path === "/oauth/token") {
      tokenCalls++;
      if (tokenCalls === 1) return send(res, 400, { error: "authorization_pending" });
      return send(res, 200, {
        api_key: "hk_live_test",
        key_id: "key_1",
        api_base: `${base}/`,
        account: { email: "a@example.com", credit_vnd: 50000 },
      });
    }
    if (!authed) return send(res, 401, { error: { code: "invalid_api_key", message: "Sai khóa" } });
    if (path === "/models") {
      return send(res, 200, {
        object: "list",
        data: [
          { id: "flash", object: "model", type: "chat", input_modalities: ["text", "image", "audio"], reasoning_efforts: ["none", "low", "medium", "high"] },
          { id: "text-embedding", object: "model", type: "embedding", dimensions: [256, 1024], default_dimensions: 1024 },
          { id: "image-3.0", object: "model", type: "image" },
        ],
      });
    }
    if (path === "/chat/completions") {
      if (body?.model === "het-tien") return send(res, 402, { error: { code: "insufficient_credit", message: "Hết credit" } });
      return send(res, 200, {
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: body?.model,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    }
    if (path === "/images/generations" || path === "/images/edits") {
      return send(res, 200, { created: 1, data: [{ b64_json: PNG_1PX }] });
    }
    if (path === "/me" && req.method === "GET") {
      return send(res, 200, { account_email: "a@example.com", credit_vnd: 12300, topup_url: "https://chat.hoiai.vn/nap" });
    }
    if (path === "/me/key" && req.method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    send(res, 404, { error: { code: "not_found", message: path } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
});

const provider = () => new HoiaiProvider("hoiai", { apiKey: "hk_live_test", baseURL: base });
const lastChatBody = () => [...seen].reverse().find((s) => s.path === "/chat/completions")?.body ?? {};

describe("HoiaiProvider — danh mục model", () => {
  it("tách model chat / embedding theo trường type", async () => {
    const p = provider();
    expect((await p.listModels()).map((m) => m.slug)).toEqual(["flash"]);
    expect(await p.listEmbeddingModels()).toEqual([
      { slug: "text-embedding", displayName: "text-embedding", dimensions: [256, 1024] },
    ]);
    expect(await p.imageModel()).toBe("image-3.0");
    expect(await p.inputModalities("flash")).toEqual(["text", "image", "audio"]);
    expect(await p.inputModalities("khong-co")).toBeNull();
  });
});

describe("HoiaiProvider — chat", () => {
  it("gửi âm thanh dạng input_audio khi model khai báo nghe được", async () => {
    const p = provider();
    await p.models();
    await p.chat({
      model: "flash",
      messages: [{ role: "user", content: "nghe giúp", audio: [{ data: "T2dnUw==", format: "ogg" }] }],
    });
    const content = (lastChatBody().messages as Array<{ content: unknown }>)[0]!.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: "text", text: "nghe giúp" },
      { type: "input_audio", input_audio: { data: "T2dnUw==", format: "ogg" } },
    ]);
  });

  it("provider OpenAI-compatible thường bỏ âm thanh (không gửi input_audio lạ)", async () => {
    const p = new OpenAICompatProvider("khac", { apiKey: "hk_live_test", baseURL: base });
    await p.chat({
      model: "flash",
      messages: [{ role: "user", content: "nghe giúp", audio: [{ data: "T2dnUw==", format: "ogg" }] }],
    });
    expect((lastChatBody().messages as Array<{ content: unknown }>)[0]!.content).toBe("nghe giúp");
  });

  it("đổi mức suy nghĩ minimal → none, không chọn mức thì không gửi", async () => {
    const p = provider();
    await p.models();
    await p.chat({ model: "flash", messages: [{ role: "user", content: "x" }], reasoningEffort: "minimal" });
    expect(lastChatBody().reasoning_effort).toBe("none");
    await p.chat({ model: "flash", messages: [{ role: "user", content: "x" }], reasoningEffort: "high" });
    expect(lastChatBody().reasoning_effort).toBe("high");
    await p.chat({ model: "flash", messages: [{ role: "user", content: "x" }] });
    expect(lastChatBody()).not.toHaveProperty("reasoning_effort");
  });

  it("hết credit (402) báo lỗi ngay, không thử lại", async () => {
    const p = provider();
    await expect(p.chat({ model: "het-tien", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ status: 402 });
    expect(seen.filter((s) => s.path === "/chat/completions")).toHaveLength(1);
  });
});

describe("HoiaiProvider — ảnh, tài khoản, thu hồi", () => {
  it("tạo ảnh trả buffer PNG; có ảnh mẫu thì gọi /images/edits", async () => {
    const backend = hoiaiImageBackend(provider());
    const img = await backend.generate({ prompt: "chai nước", aspectRatio: "16:9" });
    expect(img.mime).toBe("image/png");
    expect(img.data.length).toBeGreaterThan(10);
    const gen = seen.find((s) => s.path === "/images/generations")!.body!;
    expect(gen).toMatchObject({ model: "image-3.0", prompt: "chai nước", aspect_ratio: "16:9", response_format: "b64_json" });
    await backend.generate({ prompt: "sửa", refImages: [`data:image/png;base64,${PNG_1PX}`] });
    expect(seen.some((s) => s.path === "/images/edits")).toBe(true);
  });

  it("đọc tài khoản và tự thu hồi khóa", async () => {
    const p = provider();
    expect(await p.account()).toMatchObject({ credit_vnd: 12300, topup_url: "https://chat.hoiai.vn/nap" });
    await p.revokeKey();
    expect(seen.some((s) => s.method === "DELETE" && s.path === "/me/key")).toBe(true);
  });

  it("khóa sai báo lỗi tiếng Việt kèm status 401", async () => {
    const bad = new HoiaiProvider("hoiai", { apiKey: "hk_sai", baseURL: base });
    await expect(bad.account()).rejects.toMatchObject({ status: 401 });
  });
});

describe("Đăng nhập bằng mã kích hoạt", () => {
  it("xin mã → chờ → nhận khóa", async () => {
    const start = await hoiaiDeviceStart({ baseUrl: base, clientName: "PenAI — demo", clientUrl: "https://demo.example" });
    expect(start).toMatchObject({ deviceCode: "dc_1", userCode: "ABCD-1234", interval: 5 });
    expect(start.verificationUriComplete).toBe("https://chat.hoiai.vn/kich-hoat?code=ABCD-1234");
    const sent = seen.find((s) => s.path === "/oauth/device/code")!.body!;
    expect(sent).toMatchObject({ client_id: "penai", client_name: "PenAI — demo", client_url: "https://demo.example" });

    expect(await hoiaiDevicePoll({ baseUrl: base, deviceCode: "dc_1" })).toEqual({ status: "pending" });
    const done = await hoiaiDevicePoll({ baseUrl: base, deviceCode: "dc_1" });
    expect(done).toMatchObject({ status: "ok", apiKey: "hk_live_test", apiBase: base });
  });
});
