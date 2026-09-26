/**
 * Chat web: đính kèm file vào → lưu thư mục riêng; tải file ra qua /v1/chat/files
 * với cách ly theo người dùng (0024 + web-chat.ts).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema, hashPassword } from "@penai/shared";
import { createDb, type DbHandle } from "@penai/db";
import {
  adminQuery,
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { startMockLlm, type MockLlm } from "@penai/providers/mock-llm";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";

let fx: TestFixtures;
let dbh: DbHandle;
let mock: MockLlm;
let app: FastifyInstance;

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const sc = res.headers["set-cookie"];
  const raw = Array.isArray(sc) ? sc[0] : String(sc ?? "");
  return raw.split(";")[0] ?? "";
};
async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  const dataDir = await mkdtemp(join(tmpdir(), "penai-webfiles-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    providers: { default: { kind: "openai-compat", baseURL: mock.url } },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
  const [a] = await adminQuery<{ id: string }>(
    `INSERT INTO users (email, name, company_role, password_hash) VALUES ('a@f.local','A','owner',$1) RETURNING id`,
    [hashPassword("matkhau-a-123")],
  );
  const [b] = await adminQuery<{ id: string }>(
    `INSERT INTO users (email, name, company_role, password_hash) VALUES ('b@f.local','B','member',$1) RETURNING id`,
    [hashPassword("matkhau-b-123")],
  );
  await adminQuery(`INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1,$3,'ws_admin'),($2,$3,'member')`, [a!.id, b!.id, fx.wsA]);
  await adminQuery(`INSERT INTO agent_user_grants (workspace_id, agent_id, user_id) VALUES ($1,$2,$3)`, [fx.wsA, fx.agentA, b!.id]);
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("Chat web: file đính kèm + tải file", () => {
  let aCookie = "";
  let bCookie = "";
  let aSession = "";
  let savedP = "";
  let aId = "";

  it("gửi tin kèm file text → lưu vào thư mục riêng, agent nhận nội dung, UI nhận `saved`", async () => {
    aCookie = await login("a@f.local", "matkhau-a-123");
    bCookie = await login("b@f.local", "matkhau-b-123");
    aId = (await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: aCookie } })).json().user.id;
    const s = await app.inject({ method: "POST", url: "/v1/sessions", headers: { cookie: aCookie }, payload: { agentKey: "tro-ly" } });
    aSession = (s.json() as { session: { id: string } }).session.id;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { cookie: aCookie },
      payload: {
        sessionId: aSession,
        message: "đọc file này",
        stream: false,
        files: [{ name: "ghi chú.txt", contentB64: b64("xin chao 123"), mime: "text/plain" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { saved: Array<{ p: string; name: string }>; files: unknown[] };
    expect(j.saved).toHaveLength(1);
    // giữ tên gốc (slug hóa), không đặt theo caption như Telegram
    expect(j.saved[0]!.p).toBe("ghi-chu.txt");
    savedP = j.saved[0]!.p;

    // Lịch sử: user message chứa nội dung file inline (text nhỏ) + tên đã lưu
    const msgs = await app.inject({ method: "GET", url: `/v1/sessions/${aSession}/messages`, headers: { cookie: aCookie } });
    const users = (msgs.json() as { messages: Array<{ role: string; content: { text?: string } }> }).messages.filter((m) => m.role === "user");
    expect(users[0]!.content.text).toContain("xin chao 123");
    expect(users[0]!.content.text).toContain(`đã lưu tại: ${savedP}`);
  });

  it("tải file: chủ sở hữu 200 đúng nội dung; người khác 404; path traversal 404; ws/ chỉ operator+", async () => {
    const ok = await app.inject({ method: "GET", url: `/v1/chat/files?p=${encodeURIComponent(savedP)}`, headers: { cookie: aCookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("xin chao 123");
    expect(String(ok.headers["content-disposition"])).toContain("attachment");

    const other = await app.inject({ method: "GET", url: `/v1/chat/files?p=${encodeURIComponent(savedP)}`, headers: { cookie: bCookie } });
    expect(other.statusCode).toBe(404);

    const trav = await app.inject({ method: "GET", url: `/v1/chat/files?p=${encodeURIComponent("../../etc/passwd")}`, headers: { cookie: aCookie } });
    expect(trav.statusCode).toBe(404);

    const wsPath = `ws/users/web-${aId}/${savedP}`;
    const viaWsAdmin = await app.inject({ method: "GET", url: `/v1/chat/files?p=${encodeURIComponent(wsPath)}`, headers: { cookie: aCookie } });
    expect(viaWsAdmin.statusCode).toBe(200);
    const viaWsMember = await app.inject({ method: "GET", url: `/v1/chat/files?p=${encodeURIComponent(wsPath)}`, headers: { cookie: bCookie } });
    expect(viaWsMember.statusCode).toBe(404);
  });

  it("chỉ gửi file không kèm chữ → lưu + xác nhận, không chạy LLM; tin rỗng không file → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { cookie: aCookie },
      payload: { sessionId: aSession, message: "", stream: false, files: [{ name: "bao-cao.pdf", contentB64: b64("%PDF-1.4 fake"), mime: "application/pdf" }] },
    });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { finalText: string; saved: Array<{ p: string }> };
    expect(j.finalText).toContain("Đã lưu");
    expect(j.saved[0]!.p).toBe("bao-cao.pdf");
    const msgs = await app.inject({ method: "GET", url: `/v1/sessions/${aSession}/messages`, headers: { cookie: aCookie } });
    const all = (msgs.json() as { messages: Array<{ role: string; content: { text?: string | null } }> }).messages;
    expect(all.some((m) => m.role === "user" && m.content.text?.includes("[Đã gửi 1 file: bao-cao.pdf]"))).toBe(true);

    const empty = await app.inject({ method: "POST", url: "/v1/chat", headers: { cookie: aCookie }, payload: { sessionId: aSession, message: "   ", stream: false } });
    expect(empty.statusCode).toBe(400);
  });

  it("member gửi file với agent được gán → thư mục riêng của member, admin không đọc được bằng p trần", async () => {
    const s = await app.inject({ method: "POST", url: "/v1/sessions", headers: { cookie: bCookie }, payload: { agentKey: "tro-ly" } });
    const bSession = (s.json() as { session: { id: string } }).session.id;
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { cookie: bCookie },
      payload: { sessionId: bSession, message: "", stream: false, files: [{ name: "cua-b.csv", contentB64: b64("a,b\n1,2") }] },
    });
    expect(res.statusCode).toBe(200);
    const mine = await app.inject({ method: "GET", url: "/v1/chat/files?p=cua-b.csv", headers: { cookie: bCookie } });
    expect(mine.statusCode).toBe(200);
    const notA = await app.inject({ method: "GET", url: "/v1/chat/files?p=cua-b.csv", headers: { cookie: aCookie } });
    expect(notA.statusCode).toBe(404);
  });

  it("stream: sự kiện `saved` đi trước, [DONE] kết thúc", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { cookie: aCookie },
      payload: { sessionId: aSession, message: "xin chào", stream: true, files: [{ name: "note.md", contentB64: b64("# hi") }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"saved"');
    expect(res.body).toContain('"type":"done"');
    expect(res.body.trim().endsWith("data: [DONE]")).toBe(true);
  });
});
