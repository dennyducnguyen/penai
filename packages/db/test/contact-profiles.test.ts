import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  addMemory,
  approvePairing,
  createChannel,
  createContactTag,
  createDb,
  createPairing,
  deleteContactTag,
  findContactIdentity,
  getContactOverview,
  getOrCreateMemberPrincipal,
  getPersonContextData,
  getPersonRelated,
  getPrincipalProfile,
  listContactTags,
  listContactsOverview,
  listMemoriesForUserKey,
  listPrincipalTags,
  setPrincipalTags,
  updateContactTag,
  upsertContact,
  upsertPrincipalProfile,
  type DbHandle,
} from "../src/index.js";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "../src/testing.js";

// Hồ sơ contact, nhãn, chỉ dẫn cho AI theo từng người (migration 0029)

let fx: TestFixtures;
let dbh: DbHandle;
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });
const pgCode = (e: unknown) =>
  (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;

let an: { contactId: string; principalId: string };
let binh: { contactId: string; principalId: string };
let chau: { contactId: string; principalId: string };
let inB: { contactId: string; principalId: string };
let channelA: string;

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  const ch = await createChannel(dbh.db, ctxA(), { kind: "telegram", name: "Bot A", agentId: fx.agentA });
  channelA = ch.id;
  const open = await createChannel(dbh.db, ctxA(), {
    kind: "zalo_personal",
    name: "Zalo mở",
    agentId: fx.agentA,
    requirePairing: false,
  });
  an = await upsertContact(dbh.db, ctxA(), { channelId: ch.id, channelKind: "telegram", externalId: "111", displayName: "An" });
  binh = await upsertContact(dbh.db, ctxA(), { channelId: ch.id, channelKind: "telegram", externalId: "222", displayName: "Bình" });
  chau = await upsertContact(dbh.db, ctxA(), { channelId: open.id, channelKind: "zalo_personal", externalId: "333", displayName: "Châu" });
  await createPairing(dbh.db, ctxA(), ch.id, "AAAA1111", "111");
  await approvePairing(dbh.db, ctxA(), ch.id, "AAAA1111");
  await createPairing(dbh.db, ctxA(), ch.id, "BBBB2222", "222");
  const chB = await createChannel(dbh.db, ctxB(), { kind: "telegram", name: "Bot B", agentId: fx.agentB });
  inB = await upsertContact(dbh.db, ctxB(), { channelId: chB.id, channelKind: "telegram", externalId: "999", displayName: "Người B" });
});

afterAll(async () => {
  await dbh.close();
});

describe("listContactsOverview / getContactOverview", () => {
  it("khóa người dùng, trạng thái duyệt theo kênh, cách ly workspace", async () => {
    const rows = await listContactsOverview(dbh.db, ctxA());
    const byExt = new Map(rows.map((r) => [r.externalId, r]));
    expect(byExt.get("111")!.userKey).toBe("telegram-111");
    expect(byExt.get("111")!.pairing).toBe("da_duyet");
    expect(byExt.get("222")!.pairing).toBe("cho_duyet");
    expect(byExt.get("333")!.pairing).toBe("khong_can");
    expect(byExt.get("111")!.channelName).toBe("Bot A");
    // SQL thô trả thời gian dạng chuỗi của PostgreSQL → phải được đổi sang Date (API trả ISO)
    expect(byExt.get("111")!.lastSeen).toBeInstanceOf(Date);
    expect(byExt.get("111")!.firstSeen.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byExt.has("999")).toBe(false);
    expect(await getContactOverview(dbh.db, ctxA(), inB.contactId)).toBeNull();
    expect(await getContactOverview(dbh.db, ctxA(), "khong-phai-uuid")).toBeNull();
    expect((await getContactOverview(dbh.db, ctxA(), an.contactId))!.principalId).toBe(an.principalId);
  });

  it("findContactIdentity theo kênh + người gửi", async () => {
    expect(await findContactIdentity(dbh.db, ctxA(), channelA, "111")).toEqual(an);
    expect(await findContactIdentity(dbh.db, ctxA(), channelA, "khong-co")).toBeNull();
  });
});

describe("hồ sơ", () => {
  it("ghi toàn bộ hồ sơ, trường trống → NULL, ghi người sửa; ghi lại thì thay hẳn", async () => {
    const p = await upsertPrincipalProfile(dbh.db, ctxA(), an.principalId, {
      displayName: "Nguyễn Văn An",
      addressAs: "anh An",
      selfAddress: "em",
      roleTitle: "  ",
      phone: "0900000000",
      shareContactInfo: true,
      customFields: { "Mã khách": "KH-001" },
      aiInstructions: "  Trả lời ngắn gọn.  ",
      useInGroups: true,
    });
    expect(p).not.toBeNull();
    expect(p!.displayName).toBe("Nguyễn Văn An");
    expect(p!.roleTitle).toBeNull();
    expect(p!.aiInstructions).toBe("Trả lời ngắn gọn.");
    expect(p!.customFields).toEqual({ "Mã khách": "KH-001" });
    expect(p!.updatedBy).toBe(fx.userId);

    const again = await upsertPrincipalProfile(dbh.db, ctxA(), an.principalId, { addressAs: "anh An" });
    expect(again!.displayName).toBeNull();
    expect(again!.shareContactInfo).toBe(false);
    expect(again!.useInGroups).toBe(false);
    expect(again!.customFields).toEqual({});
    expect((await getPrincipalProfile(dbh.db, ctxA(), an.principalId))!.addressAs).toBe("anh An");

    const overview = await getContactOverview(dbh.db, ctxA(), an.contactId);
    expect(overview!.hasInstructions).toBe(false);
  });

  it("RLS: workspace khác không đọc/ghi được hồ sơ", async () => {
    await upsertPrincipalProfile(dbh.db, ctxA(), binh.principalId, { aiInstructions: "Bí mật của A" });
    expect(await getPrincipalProfile(dbh.db, ctxB(), binh.principalId)).toBeNull();
    // Gắn chéo principal của A vào workspace B → bị chặn (principal không thấy được trong B)
    expect(await upsertPrincipalProfile(dbh.db, ctxB(), binh.principalId, { aiInstructions: "chiếm" })).toBeNull();
    expect((await getPrincipalProfile(dbh.db, ctxA(), binh.principalId))!.aiInstructions).toBe("Bí mật của A");
    expect(await getPersonContextData(dbh.db, ctxB(), { principalId: binh.principalId })).toBeNull();
  });
});

describe("nhãn", () => {
  it("tạo, trùng tên không phân biệt hoa thường, sửa, gắn, xóa gỡ khỏi người", async () => {
    const vip = await createContactTag(dbh.db, ctxA(), { name: "VIP", color: "#f59e0b", aiInstructions: "Ưu tiên." });
    const daily = await createContactTag(dbh.db, ctxA(), { name: "Đại lý", useInGroups: true });
    let err: unknown;
    try {
      await createContactTag(dbh.db, ctxA(), { name: "vip" });
    } catch (e) {
      err = e;
    }
    expect(pgCode(err)).toBe("23505");
    // Workspace khác được đặt trùng tên
    const vipB = await createContactTag(dbh.db, ctxB(), { name: "VIP" });

    const updated = await updateContactTag(dbh.db, ctxA(), daily.id, { aiInstructions: "Giá đại lý." });
    expect(updated!.aiInstructions).toBe("Giá đại lý.");
    expect(await updateContactTag(dbh.db, ctxA(), vipB.id, { name: "chiếm" })).toBeNull();

    // Thứ tự theo collation của PostgreSQL → so sánh sau khi tự sắp xếp
    const names = (list: Array<{ name: string }>) => list.map((t) => t.name).sort();
    const set = await setPrincipalTags(dbh.db, ctxA(), an.principalId, [vip.id, daily.id]);
    expect(names(set!)).toEqual(["VIP", "Đại lý"]);
    // Nhãn của workspace khác → từ chối, không đổi gì
    expect(await setPrincipalTags(dbh.db, ctxA(), an.principalId, [vipB.id])).toBeNull();
    expect((await listPrincipalTags(dbh.db, ctxA(), an.principalId)).length).toBe(2);

    const tags = await listContactTags(dbh.db, ctxA());
    expect(tags.find((t) => t.id === vip.id)!.memberCount).toBe(1);
    const row = (await listContactsOverview(dbh.db, ctxA())).find((r) => r.externalId === "111")!;
    expect(names(row.tags)).toEqual(["VIP", "Đại lý"]);

    expect(await deleteContactTag(dbh.db, ctxA(), vip.id)).toBe(true);
    expect((await listPrincipalTags(dbh.db, ctxA(), an.principalId)).map((t) => t.name)).toEqual(["Đại lý"]);
    expect(await deleteContactTag(dbh.db, ctxA(), "khong-phai-uuid")).toBe(false);
  });
});

describe("dữ liệu cho ngữ cảnh AI", () => {
  it("contact: tên hồ sơ > tên kênh, nhãn kèm chỉ dẫn", async () => {
    await upsertPrincipalProfile(dbh.db, ctxA(), chau.principalId, { displayName: "Trần Châu", aiInstructions: "Nói tiếng Anh." });
    const d = await getPersonContextData(dbh.db, ctxA(), { contactId: chau.contactId });
    expect(d!.displayName).toBe("Trần Châu");
    expect(d!.channelDisplayName).toBe("Châu");
    expect(d!.firstSeen).toBeInstanceOf(Date);
    expect(d!.profile!.aiInstructions).toBe("Nói tiếng Anh.");
  });

  it("tài khoản Dashboard (principal member): tên lấy từ tài khoản", async () => {
    const pid = await getOrCreateMemberPrincipal(dbh.db, ctxA());
    const d = await getPersonContextData(dbh.db, ctxA(), { principalId: pid });
    expect(d!.displayName).toBe("Test User");
    expect(d!.profile).toBeNull();
    expect(d!.tags).toEqual([]);
  });

  it("ghi nhớ đúng người (không lẫn ghi nhớ chung của agent) + dữ liệu liên quan", async () => {
    await addMemory(dbh.db, ctxA(), { agentId: fx.agentA, tier: "semantic", content: "An thích trà", userKey: "telegram-111" });
    await addMemory(dbh.db, ctxA(), { agentId: fx.agentA, tier: "semantic", content: "Ghi nhớ chung của agent" });
    const mem = await listMemoriesForUserKey(dbh.db, ctxA(), "telegram-111");
    expect(mem.map((m) => m.content)).toEqual(["An thích trà"]);
    expect(mem[0]!.agentKey).toBe("tro-ly");
    expect(await listMemoriesForUserKey(dbh.db, ctxB(), "telegram-111")).toEqual([]);

    const rel = await getPersonRelated(dbh.db, ctxA(), {
      userKey: "telegram-111",
      principalId: an.principalId,
      channelId: channelA,
      externalId: "111",
    });
    expect(rel.sessions).toEqual([]);
    expect(rel.vaultCollections).toEqual([]);
    expect(rel.mcpGrants).toEqual([]);
    expect(rel.memoryDocs).toEqual([]);
  });
});
