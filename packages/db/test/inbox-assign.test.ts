import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  autoAssignInboxThread,
  createChannel,
  createDb,
  getInboxThread,
  inboxThreadsOfFile,
  listInboxChannelMembers,
  listInboxChannelStaff,
  listInboxThreadAssignees,
  listInboxThreads,
  listUserInboxChannelScopes,
  recordInboxMessage,
  setInboxThreadAssignees,
  setUserInboxChannels,
  type DbHandle,
} from "../src/index.js";
import { adminQuery, createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "../src/testing.js";

// Phân công hội thoại Inbox cho từng nhân viên + chia tự động xoay vòng (0040)

let fx: TestFixtures;
let dbh: DbHandle;
let ch = "";
let fb = "";
let lan = "";
let minh = "";
let hoa = "";
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });

async function mkMember(email: string, name: string): Promise<string> {
  const [u] = await adminQuery<{ id: string }>(
    `INSERT INTO users (email, name, company_role) VALUES ($1, $2, 'member') RETURNING id`,
    [email, name],
  );
  await adminQuery(`INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'member')`, [u!.id, fx.wsA]);
  return u!.id;
}

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

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  ch = (await createChannel(dbh.db, ctxA(), { kind: "zalo_personal", name: "Zalo bán hàng", agentId: fx.agentA })).id;
  fb = (await createChannel(dbh.db, ctxA(), { kind: "facebook", name: "Fanpage", agentId: fx.agentA })).id;
  lan = await mkMember("lan@test.local", "Lan");
  minh = await mkMember("minh@test.local", "Minh");
  hoa = await mkMember("hoa@test.local", "Hoa");
  for (const t of ["3001", "3002", "3003", "3004"]) await recordInboxMessage(dbh.db, ctxA(), ch, incoming(t, `m-${t}`));
});
afterAll(async () => {
  await dbh.close();
});

describe("Inbox — phạm vi theo nhân viên", () => {
  it("mặc định all; đặt assigned theo kênh; không nêu thì giữ phạm vi cũ; nhận cả kênh Fanpage", async () => {
    expect(await setUserInboxChannels(dbh.db, ctxA(), hoa, [ch])).toEqual([ch]);
    expect(await listUserInboxChannelScopes(dbh.db, ctxA(), hoa)).toEqual([{ channelId: ch, scope: "all" }]);

    await setUserInboxChannels(dbh.db, ctxA(), lan, [ch, fb], { [ch]: "assigned" });
    const scopes = await listUserInboxChannelScopes(dbh.db, ctxA(), lan);
    expect(scopes.find((s) => s.channelId === ch)?.scope).toBe("assigned");
    expect(scopes.find((s) => s.channelId === fb)?.scope).toBe("all");

    // Lưu lại không kèm scopes (bản giao diện cũ) → giữ nguyên "assigned"
    await setUserInboxChannels(dbh.db, ctxA(), lan, [ch]);
    expect(await listUserInboxChannelScopes(dbh.db, ctxA(), lan)).toEqual([{ channelId: ch, scope: "assigned" }]);
    // Giá trị lạ bị bỏ qua
    await setUserInboxChannels(dbh.db, ctxA(), lan, [ch], { [ch]: "everything" });
    expect(await listUserInboxChannelScopes(dbh.db, ctxA(), lan)).toEqual([{ channelId: ch, scope: "assigned" }]);

    await setUserInboxChannels(dbh.db, ctxA(), minh, [ch], { [ch]: "assigned" });
    const all = await listInboxChannelMembers(dbh.db, ctxA());
    expect(all.filter((m) => m.channelId === ch && m.scope === "assigned").map((m) => m.userId).sort()).toEqual([lan, minh].sort());
    // Workspace khác không thấy
    expect(await listInboxChannelMembers(dbh.db, ctxB())).toEqual([]);
  });

  it("danh sách nhân viên của kênh kèm phạm vi", async () => {
    const staff = await listInboxChannelStaff(dbh.db, ctxA(), ch);
    expect(staff.map((s) => [s.name, s.scope])).toEqual([
      ["Hoa", "all"],
      ["Lan", "assigned"],
      ["Minh", "assigned"],
    ]);
  });
});

describe("Inbox — giao hội thoại", () => {
  it("giao tay: lọc theo người được giao, lọc chưa phân công, tên người phụ trách", async () => {
    expect((await listInboxThreads(dbh.db, ctxA(), ch, { assignedTo: lan })).total).toBe(0);
    expect(await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3001", "3002"], [lan])).toEqual([lan]);

    const mine = await listInboxThreads(dbh.db, ctxA(), ch, { assignedTo: lan });
    expect(mine.threads.map((t) => t.threadId).sort()).toEqual(["3001", "3002"]);
    expect(mine.threads[0]?.assignees).toEqual([{ userId: lan, name: "Lan" }]);
    expect((await listInboxThreads(dbh.db, ctxA(), ch, { assignedTo: minh })).total).toBe(0);

    const free = await listInboxThreads(dbh.db, ctxA(), ch, { unassignedOnly: true });
    expect(free.threads.map((t) => t.threadId).sort()).toEqual(["3003", "3004"]);
    expect((await getInboxThread(dbh.db, ctxA(), ch, "3001"))?.assignees).toEqual([{ userId: lan, name: "Lan" }]);
    expect((await getInboxThread(dbh.db, ctxA(), ch, "3003"))?.assignees).toEqual([]);
  });

  it("giao thêm, thay người, bỏ phân công; người không trực kênh bị bỏ qua", async () => {
    await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3001"], [minh], "add");
    expect((await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3001")).map((a) => a.name)).toEqual(["Lan", "Minh"]);

    await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3001"], [minh], "set");
    expect((await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3001")).map((a) => a.name)).toEqual(["Minh"]);

    // fx.userId không được gán trực kênh → không giao được
    expect(await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3003"], [fx.userId], "add")).toEqual([]);
    expect(await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3003")).toEqual([]);

    // "Thay người phụ trách" bằng người không hợp lệ → giữ nguyên người cũ
    expect(await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3001"], [fx.userId], "set")).toEqual([]);
    expect((await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3001")).map((a) => a.name)).toEqual(["Minh"]);

    await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3001", "3002"], [], "set");
    expect((await listInboxThreads(dbh.db, ctxA(), ch, { unassignedOnly: true })).total).toBe(4);
  });

  it("gỡ kênh khỏi nhân viên → phân công hết hiệu lực; workspace khác không đọc được", async () => {
    await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3004"], [hoa]);
    expect((await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3004")).map((a) => a.name)).toEqual(["Hoa"]);
    expect(await listInboxThreadAssignees(dbh.db, ctxB(), ch, "3004")).toEqual([]);
    await setUserInboxChannels(dbh.db, ctxA(), hoa, []);
    expect(await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3004")).toEqual([]);
    expect((await listInboxThreads(dbh.db, ctxA(), ch, { unassignedOnly: true })).total).toBe(4);
    await setUserInboxChannels(dbh.db, ctxA(), hoa, [ch]);
    await setInboxThreadAssignees(dbh.db, ctxA(), ch, ["3004"], [], "set");
  });
});

describe("Inbox — chia tự động xoay vòng", () => {
  it("chia lần lượt cho nhân viên phạm vi assigned; hội thoại đã có người thì thôi", async () => {
    const a = await autoAssignInboxThread(dbh.db, ctxA(), ch, "3001");
    const b = await autoAssignInboxThread(dbh.db, ctxA(), ch, "3002");
    const c = await autoAssignInboxThread(dbh.db, ctxA(), ch, "3003");
    expect(a && b && c).toBeTruthy();
    // Hoa (phạm vi all) không nằm trong vòng chia
    expect([a!.userId, b!.userId].sort()).toEqual([lan, minh].sort());
    expect(c!.userId).toBe(a!.userId);
    // Đã có người phụ trách → không chia lại
    expect(await autoAssignInboxThread(dbh.db, ctxA(), ch, "3001")).toBeNull();
    expect((await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3001")).length).toBe(1);
  });

  it("bỏ qua tài khoản đã khóa; không có ai phạm vi assigned thì không chia", async () => {
    // Lượt kế tiếp lẽ ra tới người nhận 3002 — khóa người đó thì chuyển cho người còn lại
    const second = (await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3002"))[0]!.userId;
    const other = second === lan ? minh : lan;
    await adminQuery(`UPDATE users SET is_active = false WHERE id = $1`, [second]);
    expect((await autoAssignInboxThread(dbh.db, ctxA(), ch, "3004"))?.userId).toBe(other);
    await adminQuery(`UPDATE users SET is_active = true WHERE id = $1`, [second]);

    // Kênh Fanpage chưa có ai ở phạm vi assigned
    await recordInboxMessage(dbh.db, ctxA(), fb, incoming("9001", "fb-1"));
    expect(await autoAssignInboxThread(dbh.db, ctxA(), fb, "9001")).toBeNull();
  });

  it("hai tin tới cùng lúc chỉ giao cho một người", async () => {
    await recordInboxMessage(dbh.db, ctxA(), ch, incoming("3005", "m-3005"));
    const got = await Promise.all([1, 2, 3, 4].map(() => autoAssignInboxThread(dbh.db, ctxA(), ch, "3005")));
    expect(got.filter(Boolean).length).toBe(1);
    expect((await listInboxThreadAssignees(dbh.db, ctxA(), ch, "3005")).length).toBe(1);
  });
});

describe("Inbox — file theo hội thoại", () => {
  it("tra hội thoại chứa file theo đường dẫn đã lưu", async () => {
    await recordInboxMessage(
      dbh.db,
      ctxA(),
      ch,
      incoming("3001", "m-file", { contentType: "photo", text: "", media: { localPath: "/data/ws/zalo-inbox/a.png" } }),
    );
    expect(await inboxThreadsOfFile(dbh.db, ctxA(), ch, "/data/ws/zalo-inbox/a.png")).toEqual(["3001"]);
    expect(await inboxThreadsOfFile(dbh.db, ctxA(), ch, "/data/ws/zalo-inbox/khac.png")).toEqual([]);
    expect(await inboxThreadsOfFile(dbh.db, ctxB(), ch, "/data/ws/zalo-inbox/a.png")).toEqual([]);
  });
});
