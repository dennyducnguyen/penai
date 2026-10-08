import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import {
  createChannel,
  createDb,
  getInboxThread,
  getInboxThreadAgentBlock,
  listInboxMessages,
  listUserInboxChannelIds,
  recordInboxMessage,
  setUserInboxChannels,
  type DbHandle,
} from "../src/index.js";
import { withWorkspace } from "../src/context.js";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "../src/testing.js";

let fx: TestFixtures;
let dbh: DbHandle;
let wa = "";
let zaloB = "";
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  wa = (await createChannel(dbh.db, ctxA(), { kind: "whatsapp_personal", name: "WhatsApp A", agentId: fx.agentA })).id;
  zaloB = (await createChannel(dbh.db, ctxB(), { kind: "zalo_personal", name: "Zalo B", agentId: fx.agentB })).id;
});
afterAll(async () => {
  await dbh.close();
});

const msg = (over: Record<string, unknown> = {}) => ({
  threadId: "84938583264",
  peerKind: "direct" as const,
  msgId: "wa-1",
  direction: "in" as const,
  source: "peer" as const,
  senderId: "84938583264",
  senderName: "Anh Nam",
  contentType: "text",
  text: "Xin chào",
  sentAt: new Date(),
  threadName: "Anh Nam",
  ...over,
});

describe("Inbox dùng chung (0034)", () => {
  it("kênh WhatsApp: mã hội thoại dạng số điện thoại và dạng nhóm @g.us", async () => {
    const r = await recordInboxMessage(dbh.db, ctxA(), wa, msg());
    expect(r?.thread).toMatchObject({ threadId: "84938583264", unreadCount: 1, kind: "direct" });
    const g = await recordInboxMessage(
      dbh.db,
      ctxA(),
      wa,
      msg({ threadId: "120363041234567890@g.us", peerKind: "group", msgId: "wa-g1", threadName: "Nhóm bán hàng" }),
    );
    expect(g?.thread).toMatchObject({ kind: "group", name: "Nhóm bán hàng" });
  });

  it("tin cũ nhập về (history): không tăng chưa đọc, không tạm dừng AI, không đè tin gần nhất", async () => {
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    const r = await recordInboxMessage(
      dbh.db,
      ctxA(),
      wa,
      msg({ msgId: "wa-old-1", text: "Tin cũ của khách", sentAt: old }),
      { history: true },
    );
    expect(r?.thread.unreadCount).toBe(1);
    expect(r?.thread.lastMessage).toBe("Xin chào");
    const mine = await recordInboxMessage(
      dbh.db,
      ctxA(),
      wa,
      msg({ msgId: "wa-old-2", direction: "out", source: "app", text: "Tin cũ mình gửi từ điện thoại", sentAt: old }),
      { history: true, pauseMinutes: 30 },
    );
    expect(mine?.thread.unreadCount).toBe(1);
    expect(await getInboxThreadAgentBlock(dbh.db, ctxA(), wa, "84938583264")).toBeNull();
    // Hội thoại chỉ có tin cũ vẫn lấy tin cũ làm "tin gần nhất"
    const fresh = await recordInboxMessage(
      dbh.db,
      ctxA(),
      wa,
      msg({ threadId: "84900000001", senderId: "84900000001", msgId: "wa-old-3", text: "Chỉ có tin cũ", sentAt: old }),
      { history: true },
    );
    expect(fresh?.thread).toMatchObject({ lastMessage: "Chỉ có tin cũ", unreadCount: 0 });
    expect((await listInboxMessages(dbh.db, ctxA(), wa, "84938583264", { limit: 50 })).length).toBe(3);
  });

  it("thành viên được gán trực kênh WhatsApp như kênh Zalo", async () => {
    const saved = await setUserInboxChannels(dbh.db, ctxA(), fx.userId, [wa]);
    expect(saved).toEqual([wa]);
    expect(await listUserInboxChannelIds(dbh.db, ctxA(), fx.userId)).toEqual([wa]);
  });
});

describe("View tương thích zalo_* cho bản ≤ 1.8.x", () => {
  it("bản cũ đọc/ghi qua tên zalo_* vẫn vào đúng bảng inbox_*", async () => {
    // Đúng các câu lệnh bản 1.8.0 dùng: INSERT … ON CONFLICT … DO NOTHING / DO UPDATE … RETURNING
    await withWorkspace(dbh.db, ctxB(), async (tx) => {
      const ins = await tx.execute(sql`
        INSERT INTO zalo_messages (workspace_id, channel_id, thread_id, msg_id, direction, source,
          sender_id, sender_name, content_type, text, sent_at)
        VALUES (${fx.wsB}, ${zaloB}, '2002', 'old-1', 'in', 'zalo', '2002', 'Chị Hoa', 'text', 'Tin ghi bằng bản cũ', now())
        ON CONFLICT (channel_id, msg_id) WHERE msg_id <> '' DO NOTHING
        RETURNING *`);
      expect(ins.rows.length).toBe(1);
      const dup = await tx.execute(sql`
        INSERT INTO zalo_messages (workspace_id, channel_id, thread_id, msg_id, direction, source,
          sender_id, sender_name, content_type, text, sent_at)
        VALUES (${fx.wsB}, ${zaloB}, '2002', 'old-1', 'in', 'zalo', '2002', 'Chị Hoa', 'text', 'trùng', now())
        ON CONFLICT (channel_id, msg_id) WHERE msg_id <> '' DO NOTHING
        RETURNING *`);
      expect(dup.rows.length).toBe(0);
      for (const name of ["Chị Hoa", "Chị Hoa (đổi tên)"]) {
        await tx.execute(sql`
          INSERT INTO zalo_threads (workspace_id, channel_id, thread_id, kind, name, last_message, last_message_at,
            last_direction, unread_count, updated_at)
          VALUES (${fx.wsB}, ${zaloB}, '2002', 'direct', ${name}, 'Tin ghi bằng bản cũ', now(), 'in', 1, now())
          ON CONFLICT (channel_id, thread_id) DO UPDATE SET
            name = EXCLUDED.name, unread_count = zalo_threads.unread_count + 1, updated_at = now()
          RETURNING *`);
      }
      await tx.execute(sql`UPDATE zalo_threads SET ai_mode = 'off' WHERE channel_id = ${zaloB} AND thread_id = '2002'`);
      await tx.execute(sql`
        INSERT INTO zalo_channel_members (workspace_id, channel_id, user_id, granted_by)
        VALUES (${fx.wsB}, ${zaloB}, ${fx.userId}, ${fx.userId}) ON CONFLICT DO NOTHING`);
      await tx.execute(sql`
        INSERT INTO zalo_reactions (workspace_id, channel_id, thread_id, msg_id, reactor_id, reactor_name, icon, source)
        VALUES (${fx.wsB}, ${zaloB}, '2002', 'old-1', '2002', 'Chị Hoa', '/-heart', 'zalo')
        ON CONFLICT (channel_id, msg_id, reactor_id) DO UPDATE SET icon = EXCLUDED.icon`);
      await tx.execute(sql`
        INSERT INTO zalo_observed_peers (workspace_id, channel_id, chat_key, thread_id, kind, name, last_sender_id, last_sender_name)
        VALUES (${fx.wsB}, ${zaloB}, 'direct:2002', '2002', 'direct', 'Chị Hoa', '2002', 'Chị Hoa')
        ON CONFLICT (channel_id, chat_key) DO UPDATE SET message_count = zalo_observed_peers.message_count + 1`);
    });
    // Mã mới thấy đúng dữ liệu đó ở bảng inbox_*
    const thread = await getInboxThread(dbh.db, ctxB(), zaloB, "2002");
    expect(thread).toMatchObject({ name: "Chị Hoa (đổi tên)", unreadCount: 2, aiMode: "off" });
    const msgs = await listInboxMessages(dbh.db, ctxB(), zaloB, "2002", { limit: 10 });
    expect(msgs.map((m) => m.text)).toEqual(["Tin ghi bằng bản cũ"]);
    expect(await listUserInboxChannelIds(dbh.db, ctxB(), fx.userId)).toContain(zaloB);
  });

  it("view vẫn cách ly theo workspace: không thấy và không ghi được sang workspace khác", async () => {
    await withWorkspace(dbh.db, ctxA(), async (tx) => {
      const seen = await tx.execute(sql`SELECT count(*)::int AS n FROM zalo_messages WHERE channel_id = ${zaloB}`);
      expect((seen.rows[0] as { n: number }).n).toBe(0);
    });
    await expect(
      withWorkspace(dbh.db, ctxA(), (tx) =>
        tx.execute(sql`
          INSERT INTO zalo_messages (workspace_id, channel_id, thread_id, msg_id, direction, source, content_type, text)
          VALUES (${fx.wsB}, ${zaloB}, '2002', 'hack-1', 'in', 'zalo', 'text', 'ghi nhầm workspace')`),
      ),
    ).rejects.toThrow();
  });
});
