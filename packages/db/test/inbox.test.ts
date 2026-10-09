import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256hex, type WorkspaceContext } from "@penai/shared";
import {
  approveMcpOauthPending,
  consumeMcpOauthCode,
  createChannel,
  createDb,
  finishMcpServerSend,
  getMcpOauthGrant,
  getMcpOauthToken,
  getMcpServerSend,
  getInboxThreadAgentBlock,
  insertMcpOauthClient,
  insertMcpOauthPending,
  insertMcpOauthTokens,
  insertMcpServerSend,
  listMcpOauthGrants,
  listUserInboxChannelIds,
  listInboxMessages,
  listInboxThreads,
  countInboxMessages,
  searchInboxMessages,
  upsertInboxReaction,
  getInboxMessageById,
  latestIncomingInboxMessages,
  setInboxMessageCliId,
  upsertContact,
  listContactsOverview,
  exportContacts,
  listAllInboxThreads,
  lookupMcpGrantPrincipal,
  markMcpRefreshUsed,
  markInboxThreadRead,
  recordInboxMessage,
  revokeMcpOauthGrant,
  setUserInboxChannels,
  setInboxThreadAi,
  upsertInboxContacts,
  type DbHandle,
} from "../src/index.js";
import { adminQuery, createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "../src/testing.js";

let fx: TestFixtures;
let dbh: DbHandle;
let chA = "";
let chB = "";
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  chA = (await createChannel(dbh.db, ctxA(), { kind: "zalo_personal", name: "Zalo A", agentId: fx.agentA })).id;
  chB = (await createChannel(dbh.db, ctxB(), { kind: "zalo_personal", name: "Zalo B", agentId: fx.agentB })).id;
});
afterAll(async () => {
  await dbh.close();
});

const msg = (over: Record<string, unknown> = {}) => ({
  threadId: "1001",
  peerKind: "direct" as const,
  msgId: "m-1",
  direction: "in" as const,
  source: "zalo" as const,
  senderId: "1001",
  senderName: "Chị Lan",
  contentType: "text",
  text: "Còn hàng không em?",
  sentAt: new Date(),
  threadName: "Chị Lan",
  ...over,
});

describe("Zalo Inbox (0031)", () => {
  it("ghi tin + tạo hội thoại, trùng msg_id thì bỏ qua", async () => {
    const r = await recordInboxMessage(dbh.db, ctxA(), chA, msg());
    expect(r?.thread).toMatchObject({ threadId: "1001", name: "Chị Lan", unreadCount: 1, kind: "direct" });
    expect(await recordInboxMessage(dbh.db, ctxA(), chA, msg())).toBeNull();
    const list = await listInboxThreads(dbh.db, ctxA(), chA, { withMessagesOnly: true });
    expect(list.total).toBe(1);
    expect(list.threads[0]?.lastMessage).toBe("Còn hàng không em?");
  });

  it("nhân viên trả lời (web) → hết chưa đọc + AI tạm dừng; agent trả lời không tạm dừng", async () => {
    await recordInboxMessage(dbh.db, ctxA(), chA, msg({ msgId: "m-2", direction: "out", source: "agent", text: "Dạ còn ạ" }), { pauseMinutes: 30 });
    expect(await getInboxThreadAgentBlock(dbh.db, ctxA(), chA, "1001")).toBeNull();
    const r = await recordInboxMessage(
      dbh.db,
      ctxA(),
      chA,
      msg({ msgId: "m-3", direction: "out", source: "web", webUserId: fx.userId, text: "Em gửi báo giá nhé", threadName: "" }),
      { pauseMinutes: 30 },
    );
    expect(r?.thread.unreadCount).toBe(0);
    expect(r?.message.webUserName).toBeTruthy();
    expect(await getInboxThreadAgentBlock(dbh.db, ctxA(), chA, "1001")).toBe("paused");
    await setInboxThreadAi(dbh.db, ctxA(), chA, "1001", { resume: true });
    expect(await getInboxThreadAgentBlock(dbh.db, ctxA(), chA, "1001")).toBeNull();
    await setInboxThreadAi(dbh.db, ctxA(), chA, "1001", { mode: "off" });
    expect(await getInboxThreadAgentBlock(dbh.db, ctxA(), chA, "1001")).toBe("off");
  });

  it("danh sách tin theo thứ tự cũ → mới, phân trang lùi", async () => {
    const all = await listInboxMessages(dbh.db, ctxA(), chA, "1001");
    expect(all.map((m) => m.msgId)).toEqual(["m-1", "m-2", "m-3"]);
    const older = await listInboxMessages(dbh.db, ctxA(), chA, "1001", { beforeId: all[2]!.id, limit: 1 });
    expect(older.map((m) => m.msgId)).toEqual(["m-2"]);
  });

  it("đồng bộ danh bạ: bạn bè + nhóm, tìm theo tên/SĐT, không đè hội thoại đang có", async () => {
    await upsertInboxContacts(dbh.db, ctxA(), chA, [
      { threadId: "1001", kind: "direct", name: "Lan Nguyễn", phone: "0901234567" },
      { threadId: "2002", kind: "direct", name: "Anh Minh" },
      { threadId: "g-9", kind: "group", name: "Nhóm đại lý", memberCount: 25 },
    ]);
    const direct = await listInboxThreads(dbh.db, ctxA(), chA, { kind: "direct", stableOrder: true });
    expect(direct.threads.map((t) => t.threadId)).toEqual(["1001", "2002"]);
    expect(direct.threads[0]).toMatchObject({ isContact: true, phone: "0901234567", lastMessage: "Em gửi báo giá nhé" });
    const found = await listInboxThreads(dbh.db, ctxA(), chA, { q: "0901" });
    expect(found.threads.map((t) => t.threadId)).toEqual(["1001"]);
    const groups = await listInboxThreads(dbh.db, ctxA(), chA, { kind: "group" });
    expect(groups.threads[0]).toMatchObject({ name: "Nhóm đại lý", memberCount: 25 });
    await markInboxThreadRead(dbh.db, ctxA(), chA, "1001");
  });

  it("đếm + tìm trong nội dung tin (không phân biệt hoa thường, ký tự % an toàn)", async () => {
    expect(await countInboxMessages(dbh.db, ctxA(), chA, "1001")).toBe(3);
    const hits = await searchInboxMessages(dbh.db, ctxA(), chA, "BÁO GIÁ");
    expect(hits.map((h) => h.msgId)).toEqual(["m-3"]);
    expect(hits[0]).toMatchObject({ threadId: "1001", threadKind: "direct" });
    expect(await searchInboxMessages(dbh.db, ctxA(), chA, "%")).toEqual([]);
    expect(await searchInboxMessages(dbh.db, ctxA(), chA, "còn", { threadId: "khac" })).toEqual([]);
    expect(await searchInboxMessages(dbh.db, ctxB(), chA, "báo giá")).toEqual([]);
    const big = await listInboxMessages(dbh.db, ctxA(), chA, "1001", { limit: 1500, maxLimit: 2000 });
    expect(big).toHaveLength(3);
  });

  it("cảm xúc: thả, đổi, dội lại giữ nguồn, gỡ; tin có cliMsgId mới thả được", async () => {
    await recordInboxMessage(dbh.db, ctxA(), chA, msg({ msgId: "m-rx", text: "cho em hỏi giá", meta: { cliMsgId: "c-rx" } }));
    let rx = await upsertInboxReaction(dbh.db, ctxA(), chA, { threadId: "1001", msgId: "m-rx", reactorId: "me", reactorName: "Shop", icon: "/-heart", source: "web", webUserId: fx.userId });
    expect(rx).toHaveLength(1);
    expect(rx[0]).toMatchObject({ icon: "/-heart", source: "web" });
    expect(rx[0]?.webUserName).toBeTruthy();
    // bản dội lại từ điện thoại (app) cùng icon → giữ nguồn web
    rx = await upsertInboxReaction(dbh.db, ctxA(), chA, { threadId: "1001", msgId: "m-rx", reactorId: "me", reactorName: "", icon: "/-heart", source: "app" });
    expect(rx[0]).toMatchObject({ source: "web", reactorName: "Shop" });
    rx = await upsertInboxReaction(dbh.db, ctxA(), chA, { threadId: "1001", msgId: "m-rx", reactorId: "1001", reactorName: "Chị Lan", icon: "/-strong", source: "zalo" });
    expect(rx.map((r) => r.icon)).toEqual(["/-heart", "/-strong"]);
    const all = await listInboxMessages(dbh.db, ctxA(), chA, "1001");
    const target = all.find((m) => m.msgId === "m-rx")!;
    expect(target.canReact).toBe(true);
    expect(target.reactions?.length).toBe(2);
    expect(all.find((m) => m.msgId === "m-1")?.canReact).toBe(false);
    const one = await getInboxMessageById(dbh.db, ctxA(), chA, "1001", target.id);
    expect(one?.reactions?.length).toBe(2);
    const latest = await latestIncomingInboxMessages(dbh.db, ctxA(), chA, "1001", 3);
    expect(latest.map((m) => m.msgId)).toEqual(["m-rx"]);
    // tin PenAI gửi: bổ sung cliMsgId từ bản dội lại → thả được
    expect((await setInboxMessageCliId(dbh.db, ctxA(), chA, "m-3", "c-3"))?.canReact).toBe(true);
    expect(await setInboxMessageCliId(dbh.db, ctxA(), chA, "khong-co", "c")).toBeNull();
    rx = await upsertInboxReaction(dbh.db, ctxA(), chA, { threadId: "1001", msgId: "m-rx", reactorId: "me", reactorName: "", icon: "", source: "web" });
    expect(rx.map((r) => r.reactorId)).toEqual(["1001"]);
    expect(await upsertInboxReaction(dbh.db, ctxB(), chA, { threadId: "1001", msgId: "m-rx", reactorId: "x", reactorName: "", icon: "", source: "web" })).toEqual([]);
  });

  it("Contacts Zalo: người + nhóm có loại, SĐT từ danh bạ Zalo, xuất Excel theo kênh", async () => {
    await upsertContact(dbh.db, ctxA(), { channelId: chA, channelKind: "zalo_personal", externalId: "1001", displayName: "Chị Lan", metadata: { zalo_kind: "user" } });
    await upsertContact(dbh.db, ctxA(), { channelId: chA, channelKind: "zalo_personal", externalId: "g-9", metadata: { zalo_kind: "group" } });
    // tên nhóm tra được sau → cập nhật, metadata giữ nguyên
    await upsertContact(dbh.db, ctxA(), { channelId: chA, channelKind: "zalo_personal", externalId: "g-9", displayName: "Nhóm đại lý" });
    const ov = await listContactsOverview(dbh.db, ctxA());
    const lan = ov.find((o) => o.externalId === "1001")!;
    const grp = ov.find((o) => o.externalId === "g-9")!;
    expect(lan).toMatchObject({ peerKind: "direct", zaloPhone: "0901234567", channelId: chA });
    expect(grp).toMatchObject({ peerKind: "group", displayName: "Nhóm đại lý" });
    const rows = await exportContacts(dbh.db, ctxA(), chA);
    expect(rows.map((r) => r.externalId).sort()).toEqual(["1001", "g-9"]);
    expect(rows.find((r) => r.externalId === "1001")).toMatchObject({ zaloPhone: "0901234567", userKey: "zalo_personal-1001" });
    expect(await exportContacts(dbh.db, ctxA(), chB)).toEqual([]);
    const threads = await listAllInboxThreads(dbh.db, ctxA(), chA);
    expect(threads.length).toBeGreaterThanOrEqual(3);
  });

  it("cách ly workspace: workspace B không thấy hội thoại của A", async () => {
    const res = await listInboxThreads(dbh.db, ctxB(), chA, {});
    expect(res.total).toBe(0);
    expect(await listInboxMessages(dbh.db, ctxB(), chA, "1001")).toEqual([]);
  });

  it("gán kênh Zalo cho member — bỏ qua kênh không phải zalo_personal / khác workspace", async () => {
    const ids = await setUserInboxChannels(dbh.db, ctxA(), fx.userId, [chA, chB, "not-a-uuid"]);
    expect(ids).toEqual([chA]);
    expect(await listUserInboxChannelIds(dbh.db, ctxA(), fx.userId)).toEqual([chA]);
    await setUserInboxChannels(dbh.db, ctxA(), fx.userId, []);
    expect(await listUserInboxChannelIds(dbh.db, ctxA(), fx.userId)).toEqual([]);
  });

  it("chống gửi trùng MCP theo request_id", async () => {
    const input = { principal: `${fx.userId}:c1`, requestId: "req-00000001", payloadHash: "h1", tool: "zalo_send_message", channelId: chA, recipient: "1001" };
    expect(await insertMcpServerSend(dbh.db, ctxA(), input)).toBe(true);
    expect(await insertMcpServerSend(dbh.db, ctxA(), input)).toBe(false);
    await finishMcpServerSend(dbh.db, ctxA(), input.principal, input.requestId, "sent", { ok: true });
    const rec = await getMcpServerSend(dbh.db, ctxA(), input.principal, input.requestId);
    expect(rec).toMatchObject({ status: "sent", payloadHash: "h1", result: { ok: true } });
    expect(await getMcpServerSend(dbh.db, ctxB(), input.principal, input.requestId)).toBeNull();
  });
});

describe("OAuth PenAI MCP server (0031)", () => {
  it("pending → grant + code (một lần) → token → refresh dùng một lần → thu hồi", async () => {
    await adminQuery(`UPDATE users SET password_hash = 'scrypt$x' WHERE id = $1`, [fx.userId]);
    await adminQuery(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'operator') ON CONFLICT DO NOTHING`,
      [fx.wsA, fx.userId],
    );
    await insertMcpOauthClient(dbh.db, "pmc_test", { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    await insertMcpOauthPending(dbh.db, {
      id: "pend-1",
      clientId: "pmc_test",
      params: { redirectUri: "https://claude.ai/api/mcp/auth_callback", scopes: ["zalo:read", "zalo:send"] },
      csrfHash: sha256hex("csrf"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const principal = await lookupMcpGrantPrincipal(dbh.db, fx.userId, fx.wsA);
    expect(principal?.isActive).toBe(true);
    const approve = {
      pendingId: "pend-1",
      clientId: "pmc_test",
      userId: fx.userId,
      workspaceId: fx.wsA,
      scopes: ["zalo:read"],
      passwordVersion: principal!.passwordVersion,
      codeHash: sha256hex("code-1"),
      challenge: "ch",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
    };
    expect(await approveMcpOauthPending(dbh.db, approve)).toBe(true);
    expect(await approveMcpOauthPending(dbh.db, { ...approve, codeHash: sha256hex("code-2") })).toBe(false);
    const code = await consumeMcpOauthCode(dbh.db, sha256hex("code-1"));
    expect(code).toBeTruthy();
    expect(await consumeMcpOauthCode(dbh.db, sha256hex("code-1"))).toBeNull();
    const grant = await getMcpOauthGrant(dbh.db, code!.grantId);
    expect(grant).toMatchObject({ scopes: ["zalo:read"], workspaceId: fx.wsA });
    await insertMcpOauthTokens(dbh.db, {
      grantId: grant!.id,
      scopes: grant!.scopes,
      accessHash: "acc-h",
      accessExpires: new Date(Date.now() + 3600_000),
      refreshHash: "ref-h",
      refreshExpires: new Date(Date.now() + 86400_000),
    });
    expect((await getMcpOauthToken(dbh.db, "acc-h"))?.kind).toBe("access");
    expect(await markMcpRefreshUsed(dbh.db, "ref-h")).toBe(true);
    expect(await markMcpRefreshUsed(dbh.db, "ref-h")).toBe(false);
    const list = await listMcpOauthGrants(dbh.db, { workspaceId: fx.wsA });
    expect(list[0]).toMatchObject({ clientName: "Claude", redirectOrigins: ["https://claude.ai"] });
    expect(await revokeMcpOauthGrant(dbh.db, grant!.id, { workspaceId: fx.wsB })).toBe(false);
    expect(await revokeMcpOauthGrant(dbh.db, grant!.id, { workspaceId: fx.wsA })).toBe(true);
    expect((await getMcpOauthGrant(dbh.db, grant!.id))?.revokedAt).toBeTruthy();
  });
});

describe("Inbox contact aliases", () => {
  it("keeps aliases across new messages and failed syncs, searches both names, and clears removed aliases", async () => {
    const ch = (await createChannel(dbh.db, ctxA(), { kind: "zalo_personal", name: "Aliases", agentId: fx.agentA })).id;
    const contact = { threadId: "99001", kind: "direct" as const, name: "Q Th", contactAlias: "Quỳnh Thuỷ - IM GROUP" };
    await upsertInboxContacts(dbh.db, ctxA(), ch, [contact]);
    const r = await recordInboxMessage(dbh.db, ctxA(), ch, msg({ threadId: "99001", msgId: "alias-incoming", threadName: "Q Th" }));
    expect(r?.thread).toMatchObject({ name: "Q Th", contactAlias: "Quỳnh Thuỷ - IM GROUP" });
    expect((await listInboxThreads(dbh.db, ctxA(), ch, { q: "Quỳnh Thuỷ" })).total).toBe(1);
    expect((await listInboxThreads(dbh.db, ctxA(), ch, { q: "Q Th" })).total).toBe(1);
    expect((await listInboxThreads(dbh.db, ctxB(), ch, { q: "Quỳnh Thuỷ" })).total).toBe(0);
    await upsertInboxContacts(dbh.db, ctxA(), ch, [{ threadId: "99001", kind: "direct", name: "Q Th" }]);
    expect((await listInboxThreads(dbh.db, ctxA(), ch)).threads[0]?.contactAlias).toBe(contact.contactAlias);
    await upsertInboxContacts(dbh.db, ctxA(), ch, [{ ...contact, contactAlias: "Chị Thuỷ" }]);
    expect((await listInboxThreads(dbh.db, ctxA(), ch)).threads[0]?.contactAlias).toBe("Chị Thuỷ");
    await upsertInboxContacts(dbh.db, ctxA(), ch, [{ ...contact, contactAlias: "" }]);
    expect((await listInboxThreads(dbh.db, ctxA(), ch)).threads[0]?.contactAlias).toBe("");
  });
});