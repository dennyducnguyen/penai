import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PenaiConfigSchema, type PenaiConfig, type WorkspaceContext } from "@penai/shared";
import {
  createChannel,
  createCronJob,
  createDb,
  createSession,
  listCronRuns,
  loadMessages,
  mapChannelSession,
  type CronOrigin,
  type DbHandle,
} from "@penai/db";
import {
  adminQuery,
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import {
  createProviderRegistry,
  type ChatRequest,
  type ChatResponse,
  type Provider,
  type ProviderRegistry,
  type StreamEvent,
} from "@penai/providers";
import type { Channel, OutboundMessage } from "@penai/channels";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildLoopDeps, systemContext, type RuntimeDeps } from "../src/agent-runtime.js";
import { buildApp } from "../src/app.js";
import { channelHandlers } from "../src/channels-runtime.js";
import { CronRunner, framePrompt, isNoReply } from "../src/cron-runner.js";

// Agent tự đặt lịch khi chat (tool cron_*) + CronRunner gửi kết quả về cuộc trò chuyện (0030)

/** Provider giả: trả lời theo hàm, có thể chậm (để thử chống chạy trùng). */
class FakeProvider implements Provider {
  readonly name = "fake";
  delayMs = 0;
  calls = 0;
  reply: (lastUser: string) => string = (u) => `Nhắc bạn: ${u.slice(0, 40)}`;
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : "";
    return { content: this.reply(text), toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 3 } };
  }
  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await this.chat(req);
    if (response.content) yield { type: "text_delta", text: response.content };
    yield { type: "done", response };
  }
}

/** Kênh giả ghi lại tin đã gửi. */
class FakeChannel implements Channel {
  readonly kind = "telegram";
  readonly name = "Bot A";
  sent: OutboundMessage[] = [];
  constructor(readonly id: string) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
  isRunning(): boolean {
    return true;
  }
}

let fx: TestFixtures;
let dbh: DbHandle;
let config: PenaiConfig;
let providers: ProviderRegistry;
let rt: RuntimeDeps;
let provider: FakeProvider;
let channel: FakeChannel;
let channelId: string;

type ChannelOrigin = Extract<CronOrigin, { kind: "channel" }>;
const sys = (): WorkspaceContext => systemContext(fx.wsA);
const dm = (senderId: string, name = "An"): ChannelOrigin => ({
  kind: "channel",
  deliver: true,
  channelId,
  channelKind: "telegram",
  channelName: "Bot A",
  chatKey: senderId,
  peerKind: "direct",
  senderId,
  senderName: name,
});
const group = (senderId: string, name: string): ChannelOrigin => ({
  ...dm(senderId, name),
  chatKey: "-100777",
  peerKind: "group",
});

/** toolCtx.cron của một lượt chat trên kênh. */
async function cronFor(origin: CronOrigin) {
  const userKey = origin.kind === "channel" ? `telegram-${origin.senderId}` : `web-${origin.userId}`;
  const deps = await buildLoopDeps(rt, sys(), "default", {
    agentId: fx.agentA,
    userKey,
    sourceKind: "channel",
    accessRole: null,
    cronOrigin: origin,
  });
  return deps.cron!;
}

const idOf = (text: string) => /#([0-9a-f]{8})/.exec(text)![1]!;

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  config = PenaiConfigSchema.parse({ dataDir: await mkdtemp(join(tmpdir(), "penai-cron-")), providers: {} });
  providers = createProviderRegistry(config.providers);
  provider = new FakeProvider();
  providers.registerRuntime(fx.wsA, "default", provider);
  rt = { db: dbh, providers, tools: createDefaultToolRegistry(), config };
  const ch = await createChannel(dbh.db, sys(), {
    kind: "telegram",
    name: "Bot A",
    agentId: fx.agentA,
    requirePairing: false,
  });
  channelId = ch.id;
  channel = new FakeChannel(ch.id);
  channelHandlers.set(ch.id, { handler: async () => ({ kind: "ignore" }), channel, workspaceId: fx.wsA });
});

afterAll(async () => {
  channelHandlers.delete(channelId);
  await dbh.close();
});

beforeEach(async () => {
  await adminQuery("DELETE FROM cron_jobs");
  channel.sent = [];
  provider.delayMs = 0;
  provider.reply = (u) => `Nhắc bạn: ${u.slice(0, 40)}`;
});

describe("tool cron_* có trong registry và chỉ bật khi đang chat", () => {
  it("4 tool đăng ký sẵn", () => {
    const names = createDefaultToolRegistry().list().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["cron_create", "cron_list", "cron_update", "cron_delete"]));
  });

  it("không có cuộc trò chuyện / lượt chạy theo lịch → không có toolCtx.cron", async () => {
    const plain = await buildLoopDeps(rt, sys(), "default", { agentId: fx.agentA, userKey: "telegram-1" });
    expect(plain.cron).toBeUndefined();
    const inCron = await buildLoopDeps(rt, sys(), "default", {
      agentId: fx.agentA,
      userKey: "telegram-1",
      sourceKind: "cron",
      cronOrigin: dm("1"),
    });
    expect(inCron.cron).toBeUndefined();
    expect(inCron.timezone).toBe("Asia/Ho_Chi_Minh");
    const chat = await buildLoopDeps(rt, sys(), "default", {
      agentId: fx.agentA,
      userKey: "telegram-1",
      sourceKind: "channel",
      cronOrigin: dm("1"),
    });
    expect(chat.cron).toBeDefined();
  });
});

describe("cron_create / list / update / delete", () => {
  it("tạo lịch: chuẩn hóa lịch, lưu múi giờ + nơi gửi + người tạo", async () => {
    const cron = await cronFor(dm("111"));
    const out = await cron.create({ name: "Nhắc uống nước", schedule: "in 30m", prompt: "Nhắc An uống nước", deliver: true });
    expect(out).toMatch(/Đã tạo lịch #[0-9a-f]{8} "Nhắc uống nước" — chạy một lần/);
    expect(out).toMatch(/còn 30 phút; múi giờ Asia\/Ho_Chi_Minh/);
    expect(out).toContain("Kết quả gửi về: cuộc trò chuyện này");
    const [row] = await adminQuery<Record<string, unknown>>(
      "SELECT schedule, timezone, created_via, owner_key, origin, enabled FROM cron_jobs",
    );
    expect(String(row!.schedule)).toMatch(/^at \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(row).toMatchObject({
      timezone: "Asia/Ho_Chi_Minh",
      created_via: "agent",
      owner_key: "telegram-111",
      enabled: true,
      origin: { kind: "channel", deliver: true, chatKey: "111", senderId: "111", channelId },
    });
  });

  it("từ chối lịch dày quá, đã qua, sai cú pháp", async () => {
    const cron = await cronFor(dm("111"));
    const base = { name: "x", prompt: "y", deliver: true };
    await expect(cron.create({ ...base, schedule: "every 1m" })).rejects.toThrow(/tối thiểu 5 phút/);
    await expect(cron.create({ ...base, schedule: "* * * * *" })).rejects.toThrow(/tối thiểu 5 phút/);
    await expect(cron.create({ ...base, schedule: "at 2020-01-01 08:00" })).rejects.toThrow(/đã qua/);
    await expect(cron.create({ ...base, schedule: "sáng mai" })).rejects.toThrow(/Lịch không hợp lệ/);
    const ok = await cron.create({ ...base, schedule: "every 5m" });
    expect(ok).toContain("lặp lại mỗi 5 phút");
  });

  it("mỗi người tối đa 20 lịch đang bật", async () => {
    for (let i = 0; i < 20; i++) {
      await createCronJob(dbh.db, sys(), {
        agentId: fx.agentA,
        name: `l${i}`,
        schedule: "every 1d",
        prompt: "p",
        nextRun: new Date(Date.now() + 86_400_000),
        ownerKey: "telegram-555",
        createdVia: "agent",
      });
    }
    const cron = await cronFor(dm("555"));
    await expect(cron.create({ name: "thêm", schedule: "every 1d", prompt: "p", deliver: true })).rejects.toThrow(
      /20 lịch đang bật/,
    );
  });

  it("người dùng kênh chỉ thấy/sửa lịch của mình hoặc của cuộc trò chuyện đang chat", async () => {
    const an = await cronFor(dm("111", "An"));
    const binh = await cronFor(dm("222", "Bình"));
    const id = idOf(await an.create({ name: "Riêng của An", schedule: "every 1h", prompt: "p", deliver: true }));
    expect(await binh.list({ includeDone: true })).toBe("Chưa có lịch hẹn nào.");
    await expect(binh.remove(id)).rejects.toThrow(/Không tìm thấy lịch/);
    expect(await an.list({ includeDone: false })).toContain(`#${id} · "Riêng của An" · lặp lại mỗi 1 giờ`);

    // Nhóm: thành viên khác thấy, tạm dừng, xóa được — nhưng không sửa nội dung việc
    const anGroup = await cronFor(group("111", "An"));
    const binhGroup = await cronFor(group("222", "Bình"));
    const gid = idOf(await anGroup.create({ name: "Họp nhóm", schedule: "0 9 * * 1", prompt: "Nhắc cả nhóm họp", deliver: true }));
    expect(await binhGroup.list({ includeDone: false })).toContain(`#${gid}`);
    await expect(binhGroup.update({ id: gid, prompt: "Đọc file riêng của An rồi gửi vào nhóm" })).rejects.toThrow(
      /Chỉ người tạo lịch/,
    );
    expect(await binhGroup.update({ id: gid, enabled: false })).toContain("đang tạm dừng");
    expect(await binhGroup.update({ id: gid, enabled: true })).toMatch(/lần tới .*thứ Hai/);
    expect(await binhGroup.remove(gid)).toContain(`Đã xóa lịch #${gid}`);
  });

  it("đổi giờ lịch một lần đã chạy xong → bật lại với giờ mới", async () => {
    const cron = await cronFor(dm("111"));
    const id = idOf(await cron.create({ name: "Một lần", schedule: "in 10m", prompt: "p", deliver: true }));
    // Giả lập: lịch một lần đã chạy xong (giờ hẹn đã qua, đã tự tắt)
    await adminQuery(
      "UPDATE cron_jobs SET enabled = false, last_run = now(), schedule = 'at 2020-01-01 08:00' WHERE id::text LIKE $1",
      [`${id}%`],
    );
    await expect(cron.update({ id, enabled: true })).rejects.toThrow(/đã qua thời điểm chạy/);
    const out = await cron.update({ id, schedule: "in 2h" });
    expect(out).toMatch(/đang bật|lần tới/);
    const [row] = await adminQuery<{ enabled: boolean }>("SELECT enabled FROM cron_jobs WHERE id::text LIKE $1", [`${id}%`]);
    expect(row!.enabled).toBe(true);
  });
});

describe("CronRunner: tới giờ chạy và gửi kết quả về cuộc trò chuyện", () => {
  async function dueJob(origin: CronOrigin, over: { schedule?: string; prompt?: string } = {}) {
    return createCronJob(dbh.db, sys(), {
      agentId: fx.agentA,
      name: "Nhắc gọi anh Nam",
      schedule: over.schedule ?? "at 2026-01-01 08:00",
      prompt: over.prompt ?? "Nhắc An gọi anh Nam về hợp đồng ABC",
      nextRun: new Date(Date.now() - 1000),
      timezone: "Asia/Ho_Chi_Minh",
      createdVia: "agent",
      ownerKey: origin.kind === "channel" ? `telegram-${origin.senderId}` : `web-${origin.userId}`,
      origin,
    });
  }

  it("gửi tin tới đúng chat, ghi vào hội thoại hiện tại, lịch một lần tự tắt", async () => {
    const session = await createSession(dbh.db, sys(), { agentId: fx.agentA, title: "telegram:An" });
    await mapChannelSession(dbh.db, sys(), channelId, "111", session.id);
    const job = await dueJob(dm("111"));
    await new CronRunner(rt).runDueNow();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.chatKey).toBe("111");
    expect(channel.sent[0]!.text).toContain("Nhắc bạn:");
    const runs = await listCronRuns(dbh.db, sys(), job.id);
    expect(runs[0]).toMatchObject({ status: "ok" });
    expect(runs[0]!.output).toContain("đã gửi tới Bot A · An");
    const [row] = await adminQuery<{ enabled: boolean }>("SELECT enabled FROM cron_jobs WHERE id = $1", [job.id]);
    expect(row!.enabled).toBe(false);
    const msgs = await loadMessages(dbh.db, sys(), session.id);
    const last = msgs.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content.kind === "assistant" && last.content.text).toMatch(/^⏰ \[Lịch hẹn "Nhắc gọi anh Nam"\]/);
    // Lượt chạy nhận lời dặn "gửi nguyên văn tới An" + nội dung việc
    expect(provider.calls).toBeGreaterThan(0);
  });

  it("agent trả NO_REPLY → không gửi tin", async () => {
    provider.reply = () => "NO_REPLY";
    const job = await dueJob(dm("111"), { schedule: "every 1h" });
    await new CronRunner(rt).runDueNow();
    expect(channel.sent).toHaveLength(0);
    const runs = await listCronRuns(dbh.db, sys(), job.id);
    expect(runs[0]!.output).toContain("không gửi tin");
    const [row] = await adminQuery<{ enabled: boolean }>("SELECT enabled FROM cron_jobs WHERE id = $1", [job.id]);
    expect(row!.enabled).toBe(true); // lịch lặp vẫn chạy tiếp
  });

  it("lượt chạy dài hơn chu kỳ poll không bị chạy trùng", async () => {
    provider.delayMs = 400;
    const job = await dueJob(dm("111"));
    const runner = new CronRunner(rt);
    const first = runner.runDueNow();
    await new Promise((r) => setTimeout(r, 150)); // lượt 1 đang chạy, next_run chưa đổi
    await runner.runDueNow(); // như tick kế tiếp: claim lại được job nhưng phải bỏ qua
    await first;
    expect(channel.sent).toHaveLength(1);
    expect(await listCronRuns(dbh.db, sys(), job.id)).toHaveLength(1);
  });

  it("người đặt lịch bị gỡ khỏi kênh (hết duyệt) → không chạy, lịch tắt", async () => {
    const ch2 = await createChannel(dbh.db, sys(), { kind: "telegram", name: "Bot duyệt", agentId: fx.agentA });
    const fake2 = new FakeChannel(ch2.id);
    channelHandlers.set(ch2.id, { handler: async () => ({ kind: "ignore" }), channel: fake2, workspaceId: fx.wsA });
    try {
      const job = await dueJob({ ...dm("999"), channelId: ch2.id, channelName: "Bot duyệt" });
      const before = provider.calls;
      await new CronRunner(rt).runDueNow();
      expect(provider.calls).toBe(before);
      expect(fake2.sent).toHaveLength(0);
      const runs = await listCronRuns(dbh.db, sys(), job.id);
      expect(runs[0]).toMatchObject({ status: "error" });
      const [row] = await adminQuery<{ enabled: boolean }>("SELECT enabled FROM cron_jobs WHERE id = $1", [job.id]);
      expect(row!.enabled).toBe(false);
    } finally {
      channelHandlers.delete(ch2.id);
    }
  });

  it("lịch tạo trên trang Chat web: chạy theo quyền hiện tại, thành phiên chat của người đó", async () => {
    await adminQuery(
      "INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, 'operator') ON CONFLICT DO NOTHING",
      [fx.userId, fx.wsA],
    );
    const job = await dueJob({ kind: "web", deliver: true, userId: fx.userId, userName: "Test User" });
    await new CronRunner(rt).runDueNow();
    const sessions = await adminQuery<{ title: string; owner_user_id: string }>(
      "SELECT title, owner_user_id FROM sessions WHERE title LIKE '⏰%'",
    );
    expect(sessions).toEqual([{ title: "⏰ Nhắc gọi anh Nam", owner_user_id: fx.userId }]);
    const runs = await listCronRuns(dbh.db, sys(), job.id);
    expect(runs[0]).toMatchObject({ status: "ok" });
  });

  it("lịch quản trị viên tạo (không có origin) vẫn chạy như cũ, không gửi tin", async () => {
    const job = await createCronJob(dbh.db, sys(), {
      agentId: fx.agentA,
      name: "báo cáo",
      schedule: "every 1h",
      prompt: "Tổng hợp",
      nextRun: new Date(Date.now() - 1000),
    });
    await new CronRunner(rt).runDueNow();
    expect(channel.sent).toHaveLength(0);
    const runs = await listCronRuns(dbh.db, sys(), job.id);
    expect(runs[0]).toMatchObject({ status: "ok" });
    expect(runs[0]!.output).toBe("Nhắc bạn: Tổng hợp");
  });
});

describe("API Dashboard /v1/cron", () => {
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  it("tạo theo múi giờ, liệt kê kèm nhãn hiển thị, bật lại thì tính lại giờ chạy", async () => {
    const app = buildApp({ db: dbh, providers, tools: createDefaultToolRegistry(), config });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/cron",
        headers: auth(fx.keys.aAdmin),
        payload: { agentKey: "tro-ly", name: "Báo cáo sáng", schedule: "30 7 * * 1-5", prompt: "Tổng hợp" },
      });
      expect(created.statusCode).toBe(201);
      const job = (created.json() as { job: { id: string; timezone: string; createdVia: string } }).job;
      expect(job).toMatchObject({ timezone: "Asia/Ho_Chi_Minh", createdVia: "dashboard" });

      const bad = await app.inject({
        method: "POST",
        url: "/v1/cron",
        headers: auth(fx.keys.aAdmin),
        payload: { agentKey: "tro-ly", name: "x", schedule: "at 2020-01-01 08:00", prompt: "y" },
      });
      expect(bad.statusCode).toBe(400);
      expect((bad.json() as { error: string }).error).toMatch(/Lịch đã qua/);

      const viewerCreate = await app.inject({
        method: "POST",
        url: "/v1/cron",
        headers: auth(fx.keys.aViewer),
        payload: { agentKey: "tro-ly", name: "x", schedule: "every 1h", prompt: "y" },
      });
      expect(viewerCreate.statusCode).toBe(403);

      const cron = await cronFor(dm("111", "An"));
      await cron.create({ name: "Nhắc An", schedule: "in 1h", prompt: "p", deliver: true });

      const list = await app.inject({ method: "GET", url: "/v1/cron", headers: auth(fx.keys.aViewer) });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { timezone: string; jobs: Array<Record<string, unknown>> };
      expect(body.timezone).toBe("Asia/Ho_Chi_Minh");
      const admin = body.jobs.find((j) => j.name === "Báo cáo sáng")!;
      expect(admin.scheduleText).toBe("07:30 từ thứ Hai đến thứ Sáu");
      expect(admin.agentKey).toBe("tro-ly");
      const byAgent = body.jobs.find((j) => j.name === "Nhắc An")!;
      expect(byAgent).toMatchObject({ createdVia: "agent", creatorText: "An · Bot A", deliverText: "Bot A · An" });
      expect(byAgent.origin).toBeUndefined();

      const off = await app.inject({
        method: "PATCH",
        url: `/v1/cron/${job.id}`,
        headers: auth(fx.keys.aAdmin),
        payload: { enabled: false },
      });
      expect(off.statusCode).toBe(200);
      // Giả lập: tắt đã lâu, next_run nằm trong quá khứ → bật lại không được chạy bù ngay
      await adminQuery("UPDATE cron_jobs SET next_run = now() - interval '3 days' WHERE id = $1", [job.id]);
      const on = await app.inject({
        method: "PATCH",
        url: `/v1/cron/${job.id}`,
        headers: auth(fx.keys.aAdmin),
        payload: { enabled: true },
      });
      expect(on.statusCode).toBe(200);
      const next = new Date((on.json() as { job: { nextRun: string } }).job.nextRun);
      expect(next.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });
});

describe("hàm thuần", () => {
  it("isNoReply", () => {
    expect(isNoReply("NO_REPLY")).toBe(true);
    expect(isNoReply(" no_reply. ")).toBe(true);
    expect(isNoReply("**NO_REPLY**")).toBe(true);
    expect(isNoReply("NO_REPLY vì hôm nay nghỉ")).toBe(false);
  });

  it("framePrompt nói rõ gửi cho ai, ở đâu", () => {
    const text = framePrompt(
      { name: "Nhắc họp", prompt: "Nhắc cả nhóm họp lúc 9h" },
      group("111", "An"),
      new Date("2026-09-28T01:00:00Z"),
      "Asia/Ho_Chi_Minh",
    );
    expect(text).toContain('[Lịch hẹn "Nhắc họp" — tới giờ chạy lúc 08:00 thứ Hai 28/09/2026]');
    expect(text).toContain("Việc cần làm: Nhắc cả nhóm họp lúc 9h");
    expect(text).toContain("tới An (nhóm chat trên Bot A)");
    expect(text).toContain("NO_REPLY");
  });
});
