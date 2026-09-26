import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createChannel,
  listChannels,
  listEnabledChannels,
  createSession,
  getChannelSession,
  mapChannelSession,
  createPairing,
  isPaired,
  approvePairing,
  upsertContact,
  listContacts,
  type DbHandle,
} from "../src/index.js";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "../src/testing.js";

let fx: TestFixtures;
let dbh: DbHandle;
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});
afterAll(async () => {
  await dbh.close();
});

describe("channels + pairing + contacts (RLS)", () => {
  it("tạo channel + list scoped theo workspace", async () => {
    const ch = await createChannel(dbh.db, ctxA(), {
      kind: "telegram",
      name: "Bot kế toán",
      agentId: fx.agentA,
      tokenEncrypted: "v1.fake",
    });
    expect(ch.id).toBeTruthy();

    const inA = await listChannels(dbh.db, ctxA());
    expect(inA.map((c) => c.id)).toContain(ch.id);
    const inB = await listChannels(dbh.db, ctxB());
    expect(inB.map((c) => c.id)).not.toContain(ch.id); // cách ly
  });

  it("listEnabledChannels thấy channel enabled (dùng lúc boot)", async () => {
    const all = await listEnabledChannels(dbh.db);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((c) => c.workspaceId)).toBe(true);
  });

  it("ánh xạ chat → session", async () => {
    const chans = await listChannels(dbh.db, ctxA());
    const ch = chans[0]!;
    const s = await createSession(dbh.db, ctxA(), { agentId: fx.agentA });
    expect(await getChannelSession(dbh.db, ctxA(), ch.id, "chat-123")).toBeNull();
    await mapChannelSession(dbh.db, ctxA(), ch.id, "chat-123", s.id);
    expect(await getChannelSession(dbh.db, ctxA(), ch.id, "chat-123")).toBe(s.id);
  });

  it("pairing: chưa duyệt → not paired; duyệt → paired", async () => {
    const ch = (await listChannels(dbh.db, ctxA()))[0]!;
    expect(await isPaired(dbh.db, ctxA(), ch.id, "user-9")).toBe(false);
    await createPairing(dbh.db, ctxA(), ch.id, "ABCD2345", "user-9");
    expect(await isPaired(dbh.db, ctxA(), ch.id, "user-9")).toBe(false); // pending
    const approved = await approvePairing(dbh.db, ctxA(), ch.id, "ABCD2345");
    expect(approved?.externalUserId).toBe("user-9");
    expect(await isPaired(dbh.db, ctxA(), ch.id, "user-9")).toBe(true);
  });

  it("contacts upsert + dedup theo (workspace, kind, external_id)", async () => {
    await upsertContact(dbh.db, ctxA(), { channelKind: "telegram", externalId: "u1", displayName: "An" });
    await upsertContact(dbh.db, ctxA(), { channelKind: "telegram", externalId: "u1", displayName: "An Nguyen" });
    const list = await listContacts(dbh.db, ctxA());
    const u1 = list.filter((c) => c.externalId === "u1");
    expect(u1).toHaveLength(1); // dedup
    expect(u1[0]!.displayName).toBe("An Nguyen"); // cập nhật
  });
});
