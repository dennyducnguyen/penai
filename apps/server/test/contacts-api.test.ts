import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema, type PenaiConfig, type WorkspaceContext } from "@penai/shared";
import { createChannel, createDb, upsertContact, type DbHandle } from "@penai/db";
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

// API hồ sơ contact, nhãn, USER.md, xem trước ngữ cảnh (0029)

let fx: TestFixtures;
let dbh: DbHandle;
let mock: MockLlm;
let app: FastifyInstance;
let config: PenaiConfig;
let contactId: string;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  config = PenaiConfigSchema.parse({
    dataDir: await mkdtemp(join(tmpdir(), "penai-contacts-")),
    providers: { default: { kind: "openai-compat", baseURL: mock.url } },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
  const ch = await createChannel(dbh.db, ctxA(), { kind: "telegram", name: "Bot A", agentId: fx.agentA });
  contactId = (
    await upsertContact(dbh.db, ctxA(), { channelId: ch.id, channelKind: "telegram", externalId: "111", displayName: "An" })
  ).contactId;
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("Contacts API", () => {
  it("danh sách: mọi role; chi tiết: từ operator; workspace khác không thấy", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/contacts", headers: auth(fx.keys.aViewer) });
    expect(list.statusCode).toBe(200);
    const c = (list.json() as { contacts: Array<Record<string, unknown>> }).contacts.find((x) => x.externalId === "111")!;
    // Trang MCP dùng lại các trường cũ này
    expect(c.channelKind).toBe("telegram");
    expect(c.displayName).toBe("An");
    expect(c.userKey).toBe("telegram-111");
    expect(c.pairing).toBe("chua_duyet");

    const viewer = await app.inject({ method: "GET", url: `/v1/contacts/${contactId}`, headers: auth(fx.keys.aViewer) });
    expect(viewer.statusCode).toBe(403);
    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${contactId}`, headers: auth(fx.keys.aOperator) });
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as {
      contact: { id: string };
      profile: unknown;
      userMd: { exists: boolean };
      channel: { agentKey: string };
      limits: { personInstructions: number };
    };
    expect(d.contact.id).toBe(contactId);
    expect(d.profile).toBeNull();
    expect(d.userMd.exists).toBe(false);
    expect(d.channel.agentKey).toBe("tro-ly");
    expect(d.limits.personInstructions).toBe(2000);

    const otherWs = await app.inject({ method: "GET", url: `/v1/contacts/${contactId}`, headers: auth(fx.keys.bOperator) });
    expect(otherWs.statusCode).toBe(404);
    const badId = await app.inject({ method: "GET", url: "/v1/contacts/khong-phai-uuid", headers: auth(fx.keys.aOperator) });
    expect(badId.statusCode).toBe(404);
  });

  it("hồ sơ: kiểm độ dài, bỏ trường tùy chỉnh trống, ghi audit; viewer không sửa được", async () => {
    const url = `/v1/contacts/${contactId}/profile`;
    const tooLong = await app.inject({
      method: "PUT",
      url,
      headers: auth(fx.keys.aOperator),
      payload: { aiInstructions: "x".repeat(2001) },
    });
    expect(tooLong.statusCode).toBe(400);
    const viewer = await app.inject({ method: "PUT", url, headers: auth(fx.keys.aViewer), payload: {} });
    expect(viewer.statusCode).toBe(403);

    const ok = await app.inject({
      method: "PUT",
      url,
      headers: auth(fx.keys.aOperator),
      payload: {
        displayName: "Nguyễn Văn An",
        addressAs: "anh An",
        selfAddress: "em",
        customFields: { "Mã khách": "KH-001", "Ghi chú": "  " },
        aiInstructions: "Trả lời ngắn gọn.",
      },
    });
    expect(ok.statusCode).toBe(200);
    const profile = (ok.json() as { profile: { customFields: Record<string, string>; displayName: string } }).profile;
    expect(profile.customFields).toEqual({ "Mã khách": "KH-001" });
    expect(profile.displayName).toBe("Nguyễn Văn An");

    const audit = await adminQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND action = 'contact.profile.update'",
      [fx.wsA],
    );
    expect(audit[0]!.n).toBe(1);
  });

  it("nhãn: chỉ ws_admin tạo/sửa; trùng tên 409; gắn nhãn cho người", async () => {
    const byOperator = await app.inject({
      method: "POST",
      url: "/v1/contact-tags",
      headers: auth(fx.keys.aOperator),
      payload: { name: "VIP" },
    });
    expect(byOperator.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/v1/contact-tags",
      headers: auth(fx.keys.aAdmin),
      payload: { name: "VIP", color: "#f59e0b", aiInstructions: "Khách VIP: ưu tiên." },
    });
    expect(created.statusCode).toBe(201);
    const tagId = (created.json() as { tag: { id: string } }).tag.id;

    const dup = await app.inject({ method: "POST", url: "/v1/contact-tags", headers: auth(fx.keys.aAdmin), payload: { name: "vip" } });
    expect(dup.statusCode).toBe(409);
    const badColor = await app.inject({
      method: "POST",
      url: "/v1/contact-tags",
      headers: auth(fx.keys.aAdmin),
      payload: { name: "Đỏ", color: "đỏ" },
    });
    expect(badColor.statusCode).toBe(400);

    const setTags = await app.inject({
      method: "PUT",
      url: `/v1/contacts/${contactId}/tags`,
      headers: auth(fx.keys.aOperator),
      payload: { tagIds: [tagId] },
    });
    expect(setTags.statusCode).toBe(200);
    expect((setTags.json() as { tags: Array<{ name: string }> }).tags.map((t) => t.name)).toEqual(["VIP"]);
    const unknownTag = await app.inject({
      method: "PUT",
      url: `/v1/contacts/${contactId}/tags`,
      headers: auth(fx.keys.aOperator),
      payload: { tagIds: ["00000000-0000-4000-8000-000000000000"] },
    });
    expect(unknownTag.statusCode).toBe(400);

    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/contact-tags/${tagId}`,
      headers: auth(fx.keys.aAdmin),
      payload: { useInGroups: true },
    });
    expect(patched.statusCode).toBe(200);

    const tagsB = await app.inject({ method: "GET", url: "/v1/contact-tags", headers: auth(fx.keys.bOperator) });
    expect((tagsB.json() as { tags: unknown[] }).tags).toEqual([]);
  });

  it("USER.md: lưu (chuẩn hóa xuống dòng) và đọc lại ở trang chi tiết", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/v1/contacts/${contactId}/user-md`,
      headers: auth(fx.keys.aOperator),
      payload: { content: "# Ghi nhớ\r\n- Thích trà sen" },
    });
    expect(put.statusCode).toBe(200);
    const onDisk = await readFile(join(config.dataDir, fx.wsA, "users", "telegram-111", "USER.md"), "utf8");
    expect(onDisk).toBe("# Ghi nhớ\n- Thích trà sen\n");
    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${contactId}`, headers: auth(fx.keys.aOperator) });
    const d = detail.json() as { userMd: { exists: boolean; content: string }; files: Array<{ path: string }> };
    expect(d.userMd.exists).toBe(true);
    expect(d.userMd.content).toContain("Thích trà sen");
    expect(d.files.map((f) => f.path)).toContain("USER.md");
  });

  it("xem trước ngữ cảnh: prompt agent đứng đầu, người đang chat + chỉ dẫn đứng cuối; nhóm chat bỏ chỉ dẫn riêng", async () => {
    const pv = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactId}/context-preview?message=${encodeURIComponent("Xin chào")}`,
      headers: auth(fx.keys.aOperator),
    });
    expect(pv.statusCode).toBe(200);
    const s = (pv.json() as { systemPrompt: string }).systemPrompt;
    expect(s.startsWith("Bạn là trợ lý test.")).toBe(true);
    const iGuide = s.indexOf("# Thư mục làm việc");
    const iUserMd = s.indexOf("Thích trà sen");
    const iPerson = s.indexOf("# Người đang chat");
    const iAdmin = s.indexOf("# Chỉ dẫn của quản trị viên cho người này");
    expect(iGuide).toBeGreaterThan(0);
    expect(iUserMd).toBeGreaterThan(iGuide);
    expect(iPerson).toBeGreaterThan(iUserMd);
    expect(iAdmin).toBeGreaterThan(iPerson);
    expect(s).toContain('- Tên: Nguyễn Văn An (tên trên Telegram: "An")');
    expect(s).toContain('gọi người này là "anh An"');
    expect(s).toContain('## Theo nhãn "VIP"');
    expect(s.trimEnd().endsWith("Trả lời ngắn gọn.")).toBe(true);

    const group = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactId}/context-preview?group=1`,
      headers: auth(fx.keys.aOperator),
    });
    const g = (group.json() as { systemPrompt: string }).systemPrompt;
    expect(g).toContain("nhóm chat (nhiều người cùng đọc)");
    expect(g).toContain('## Theo nhãn "VIP"'); // nhãn đã bật dùng trong nhóm
    expect(g).not.toContain("Trả lời ngắn gọn.");
    expect(g).not.toContain("Mã khách");
  });

  it("sửa agent được ghi audit (ai đổi Thinking, lúc nào)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${fx.agentA}`,
      headers: auth(fx.keys.aAdmin),
      payload: { thinkingLevel: "low" },
    });
    expect(res.statusCode).toBe(200);
    const rows = await adminQuery<{ detail: { thinkingLevel?: string; fields?: string[] } }>(
      "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'agent.update'",
      [fx.wsA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail.thinkingLevel).toBe("low");
    expect(rows[0]!.detail.fields).toEqual(["thinkingLevel"]);
  });
});
