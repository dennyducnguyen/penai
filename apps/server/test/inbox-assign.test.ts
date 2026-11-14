/**
 * Inbox — phân công hội thoại cho từng nhân viên (0040): nhân viên ở phạm vi "chỉ hội thoại được giao"
 * chỉ thấy/trả lời hội thoại của mình; người phạm vi "tất cả" và quản trị như trước.
 * Chạy trên Postgres thật.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema, type WorkspaceContext } from "@penai/shared";
import { createChannel, createDb, recordInboxMessage, type DbHandle } from "@penai/db";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { startMockLlm, type MockLlm } from "@penai/providers/mock-llm";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";
import { memberAllowed } from "../src/web-auth.js";

let fx: TestFixtures;
let dbh: DbHandle;
let mock: MockLlm;
let app: FastifyInstance;
let dataDir = "";
let ch = "";
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
const PASS = "matkhau-nhan-vien-1";

const admin = () => ({ authorization: `Bearer ${fx.keys.aAdmin}` });
const as = (who: string) => ({ cookie: cookies[who]! });
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });

const incoming = (threadId: string, msgId: string, over: Record<string, unknown> = {}) => ({
  threadId,
  peerKind: "direct" as const,
  msgId,
  direction: "in" as const,
  source: "peer" as const,
  senderId: threadId,
  senderName: `Khách ${threadId}`,
  contentType: "text",
  text: "Xin chào",
  sentAt: new Date(),
  threadName: `Khách ${threadId}`,
  ...over,
});

async function mkMember(who: string, scope: "all" | "assigned"): Promise<void> {
  const email = `${who}@assign.test`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: admin(),
    payload: { email, name: who, password: PASS, role: "member", zaloChannelIds: [ch], inboxScopes: { [ch]: scope } },
  });
  expect(res.statusCode).toBe(201);
  ids[who] = (res.json() as { id: string }).id;
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASS } });
  expect(login.statusCode).toBe(200);
  const sc = login.headers["set-cookie"];
  cookies[who] = (Array.isArray(sc) ? sc[0]! : String(sc ?? "")).split(";")[0] ?? "";
}

const threadsOf = async (headers: Record<string, string>, qs = "") => {
  const res = await app.inject({ method: "GET", url: `/v1/inbox/${ch}/threads?limit=200${qs}`, headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { threads: Array<{ threadId: string; assignees: Array<{ userId: string; name: string }> }> }).threads;
};
const assign = (threadIds: string[], userIds: string[], mode = "set", headers: Record<string, string> = admin()) =>
  app.inject({ method: "POST", url: `/v1/inbox/${ch}/assign`, headers, payload: { threadIds, userIds, mode } });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  dataDir = await mkdtemp(join(tmpdir(), "penai-inbox-assign-"));
  const config = PenaiConfigSchema.parse({ dataDir, providers: { default: { kind: "openai-compat", baseURL: mock.url } } });
  app = buildApp({ db: dbh, providers: createProviderRegistry(config.providers), tools: createDefaultToolRegistry(), config });
  ch = (await createChannel(dbh.db, ctxA(), { kind: "zalo_personal", name: "Zalo bán hàng", agentId: fx.agentA })).id;
  for (const t of ["2001", "2002", "2003"]) await recordInboxMessage(dbh.db, ctxA(), ch, incoming(t, `m-${t}`));
  await mkMember("lan", "assigned");
  await mkMember("minh", "assigned");
  await mkMember("hoa", "all");
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("Inbox — phân công hội thoại (API)", () => {
  it("trang Người dùng trả phạm vi theo kênh; kênh của nhân viên có scope", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/users", headers: admin() });
    const users = (list.json() as { users: Array<{ id: string; zaloChannelIds: string[]; inboxAssignedChannelIds: string[] }> }).users;
    expect(users.find((u) => u.id === ids.lan)).toMatchObject({ zaloChannelIds: [ch], inboxAssignedChannelIds: [ch] });
    expect(users.find((u) => u.id === ids.hoa)).toMatchObject({ zaloChannelIds: [ch], inboxAssignedChannelIds: [] });

    const mine = await app.inject({ method: "GET", url: "/v1/inbox/channels", headers: as("lan") });
    expect((mine.json() as { channels: Array<{ id: string; scope: string }>; canManage: boolean })).toMatchObject({
      channels: [{ id: ch, scope: "assigned", autoAssign: false }],
      canManage: false,
    });
    const full = await app.inject({ method: "GET", url: "/v1/inbox/channels", headers: as("hoa") });
    expect((full.json() as { channels: Array<{ scope: string }> }).channels[0]?.scope).toBe("all");
  });

  it("chưa giao: nhân viên bị giới hạn không thấy gì và bị chặn ở mọi thao tác; người phạm vi all thấy hết", async () => {
    expect(await threadsOf(as("lan"))).toEqual([]);
    expect((await threadsOf(as("lan"), "&q=Kh%C3%A1ch")).length).toBe(0);
    expect((await threadsOf(as("lan"), "&all=1")).length).toBe(0);
    expect((await threadsOf(as("hoa"))).length).toBe(3);
    expect((await threadsOf(admin())).length).toBe(3);

    const base = `/v1/inbox/${ch}/threads/2001`;
    const calls: Array<[string, string, Record<string, unknown>?]> = [
      ["GET", `${base}/messages`],
      ["POST", `${base}/read`, {}],
      ["POST", `${base}/send`, { text: "alo" }],
      ["PUT", `${base}/ai`, { mode: "off" }],
      ["POST", `${base}/messages/1/react`, { reaction: "heart" }],
      ["POST", `/v1/inbox/${ch}/new`, { to: "2001", text: "alo" }],
      ["POST", `/v1/inbox/${ch}/new`, { phone: "0912345678", text: "alo" }],
      ["GET", `/v1/inbox/${ch}/find-phone?phone=0912345678`],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as "GET", url, headers: as("lan"), ...(payload ? { payload } : {}) });
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
    // Người phạm vi all vẫn đọc được như trước
    expect((await app.inject({ method: "GET", url: `${base}/messages`, headers: as("hoa") })).statusCode).toBe(200);
  });

  it("chỉ vận hành trở lên được phân công; member bị chặn ngay ở danh sách route cho phép", async () => {
    expect(memberAllowed("POST", `/v1/inbox/${ch}/assign`)).toBe(false);
    expect(memberAllowed("GET", `/v1/inbox/${ch}/staff`)).toBe(false);
    expect((await assign(["2001"], [ids.lan!], "set", as("hoa"))).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/v1/inbox/${ch}/staff`, headers: as("lan") })).statusCode).toBe(403);
    expect((await assign(["2001"], [ids.lan!], "set", { authorization: `Bearer ${fx.keys.aViewer}` })).statusCode).toBe(403);
    expect((await assign(["2001"], [ids.lan!], "set", { authorization: `Bearer ${fx.keys.bOperator}` })).statusCode).toBe(403);

    const staff = await app.inject({ method: "GET", url: `/v1/inbox/${ch}/staff`, headers: { authorization: `Bearer ${fx.keys.aOperator}` } });
    expect((staff.json() as { staff: Array<{ name: string; scope: string }> }).staff.map((s) => [s.name, s.scope])).toEqual([
      ["hoa", "all"],
      ["lan", "assigned"],
      ["minh", "assigned"],
    ]);
  });

  it("giao 2001 cho Lan: Lan thấy và thao tác được đúng hội thoại đó, Minh không", async () => {
    const res = await assign(["2001"], [ids.lan!]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, userIds: [ids.lan], threads: 1 });

    const lan = await threadsOf(as("lan"));
    expect(lan.map((t) => t.threadId)).toEqual(["2001"]);
    expect(lan[0]?.assignees).toEqual([{ userId: ids.lan, name: "lan" }]);
    expect(await threadsOf(as("minh"))).toEqual([]);

    const ok = await app.inject({ method: "GET", url: `/v1/inbox/${ch}/threads/2001/messages`, headers: as("lan") });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { messages: unknown[]; thread: { assignees: unknown[] } }).messages.length).toBe(1);
    expect((await app.inject({ method: "POST", url: `/v1/inbox/${ch}/threads/2001/read`, headers: as("lan"), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/v1/inbox/${ch}/threads/2001/ai`, headers: as("lan"), payload: { mode: "off" } })).statusCode).toBe(200);
    // Gửi: qua được bước kiểm quyền (kênh thử không kết nối → 409, không phải 403)
    expect((await app.inject({ method: "POST", url: `/v1/inbox/${ch}/threads/2001/send`, headers: as("lan"), payload: { text: "Dạ" } })).statusCode).toBe(409);

    expect((await app.inject({ method: "GET", url: `/v1/inbox/${ch}/threads/2002/messages`, headers: as("lan") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/v1/inbox/${ch}/threads/2001/messages`, headers: as("minh") })).statusCode).toBe(403);
  });

  it("lọc chưa phân công / giao cho tôi; giao nhiều hội thoại; bỏ phân công", async () => {
    expect((await threadsOf(admin(), "&assign=none")).map((t) => t.threadId).sort()).toEqual(["2002", "2003"]);
    // Người bị giới hạn không dùng bộ lọc này để nhìn hội thoại chưa giao
    expect((await threadsOf(as("lan"), "&assign=none")).map((t) => t.threadId)).toEqual(["2001"]);

    expect((await assign(["2002", "2003"], [ids.minh!, ids.hoa!], "add")).statusCode).toBe(200);
    expect((await threadsOf(as("minh"))).map((t) => t.threadId).sort()).toEqual(["2002", "2003"]);
    expect((await threadsOf(as("hoa"), "&assign=mine")).map((t) => t.threadId).sort()).toEqual(["2002", "2003"]);
    expect((await threadsOf(admin(), "&assign=none")).length).toBe(0);

    // Người không trực kênh → báo lỗi, không đổi gì
    expect((await assign(["2001"], [fx.userId])).statusCode).toBe(400);
    expect((await threadsOf(as("lan"))).map((t) => t.threadId)).toEqual(["2001"]);
    expect((await assign(["2001"], ["khong-phai-uuid"])).statusCode).toBe(400);
    expect((await assign([], [ids.lan!])).statusCode).toBe(400);

    expect((await assign(["2002"], [], "set")).statusCode).toBe(200);
    expect((await threadsOf(as("minh"))).map((t) => t.threadId)).toEqual(["2003"]);
    expect((await app.inject({ method: "GET", url: `/v1/inbox/${ch}/threads/2002/messages`, headers: as("minh") })).statusCode).toBe(403);
  });

  it("file: nhân viên chỉ tải được file thuộc hội thoại mình được xem", async () => {
    const dir = resolve(join(dataDir, fx.wsA, "zalo-inbox", ch));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cua-lan.bin"), "a");
    await writeFile(join(dir, "cua-nguoi-khac.bin"), "b");
    await writeFile(join(dir, "khong-thuoc-tin-nao.bin"), "c");
    await recordInboxMessage(dbh.db, ctxA(), ch, incoming("2001", "f-1", { contentType: "file", media: { localPath: join(dir, "cua-lan.bin") } }));
    await recordInboxMessage(dbh.db, ctxA(), ch, incoming("2002", "f-2", { contentType: "file", media: { localPath: join(dir, "cua-nguoi-khac.bin") } }));
    const get = (who: Record<string, string>, name: string) =>
      app.inject({ method: "GET", url: `/v1/inbox/${ch}/file?p=${encodeURIComponent(`zalo-inbox/${ch}/${name}`)}`, headers: who });

    expect((await get(as("lan"), "cua-lan.bin")).statusCode).toBe(200);
    expect((await get(as("lan"), "cua-nguoi-khac.bin")).statusCode).toBe(404);
    expect((await get(as("lan"), "khong-thuoc-tin-nao.bin")).statusCode).toBe(404);
    // Phạm vi all: file của mọi hội thoại trong kênh, nhưng không phải file bất kỳ của workspace
    expect((await get(as("hoa"), "cua-nguoi-khac.bin")).statusCode).toBe(200);
    expect((await get(as("hoa"), "khong-thuoc-tin-nao.bin")).statusCode).toBe(404);
    expect((await get(admin(), "khong-thuoc-tin-nao.bin")).statusCode).toBe(200);
  });

  it("công tắc chia tự động: mặc định tắt, chỉ quản trị bật", async () => {
    const off = await app.inject({ method: "GET", url: "/v1/inbox/channels", headers: admin() });
    expect((off.json() as { channels: Array<{ id: string; autoAssign: boolean }> }).channels.find((c) => c.id === ch)?.autoAssign).toBe(false);
    const denied = await app.inject({
      method: "PUT",
      url: `/v1/inbox/${ch}/settings`,
      headers: { authorization: `Bearer ${fx.keys.aOperator}` },
      payload: { autoAssign: true },
    });
    expect(denied.statusCode).toBe(403);
    const on = await app.inject({ method: "PUT", url: `/v1/inbox/${ch}/settings`, headers: admin(), payload: { autoAssign: true } });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { autoAssign: boolean }).autoAssign).toBe(true);
    const after = await app.inject({ method: "GET", url: "/v1/inbox/channels", headers: admin() });
    expect((after.json() as { channels: Array<{ id: string; autoAssign: boolean }> }).channels.find((c) => c.id === ch)?.autoAssign).toBe(true);
  });

  it("đổi phạm vi về all → thấy lại mọi hội thoại; gỡ người dùng → hết phân công", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/users/${ids.lan}`,
      headers: admin(),
      payload: { zaloChannelIds: [ch], inboxScopes: { [ch]: "all" } },
    });
    expect(patch.statusCode).toBe(200);
    expect((await threadsOf(as("lan"))).length).toBe(3);

    const rm = await app.inject({ method: "DELETE", url: `/v1/users/${ids.minh}`, headers: admin() });
    expect(rm.statusCode).toBe(200);
    const t2003 = (await threadsOf(admin())).find((t) => t.threadId === "2003");
    expect(t2003?.assignees.map((a) => a.name)).toEqual(["hoa"]);
  });
});
