import { basename } from "node:path";
import { canChat, logger, type WorkspaceContext, type WorkspaceRole } from "@penai/shared";
import {
  appendMessage,
  canAccessAgent,
  claimDueCronJobs,
  createSession,
  getActiveMemberRole,
  getAgentById,
  getChannelById,
  getChannelSession,
  getCronJob,
  isPaired,
  listCronRuns,
  recordCronRun,
  recordTraceSafe,
  updateCronNextRun,
  type CronJobRow,
  type CronOrigin,
  type DueCronJob,
} from "@penai/db";
import { formatInZone, nextRun, runAgent, Scheduler } from "@penai/core";
import type { Channel } from "@penai/channels";
import { buildLoopDeps, agentOpts, reasoningEffortOf, systemContext, type RuntimeDeps } from "./agent-runtime.js";
import { channelHandlers, scheduleOnChannelQueue } from "./channels-runtime.js";
import { createOutboundCollector, describeOutbound, filesMarker, webDirs } from "./web-chat.js";

const POLL_MS = 20_000;
const BATCH = 10;
/** Lời nhắc một lần chưa gửi được vì lỗi tạm thời → thử lại trong khoảng này. */
const ONE_SHOT_RETRY_MS = 30 * 60_000;
const MEDIA_MARKER_RE = /\[\[media:[^\]]+\]\]/g;

/** Agent trả đúng từ này = lượt này không có gì cần báo, không gửi tin. */
export const CRON_NO_REPLY = "NO_REPLY";

export function isNoReply(text: string): boolean {
  return text.replace(/[\s.!*_`"'“”]/g, "").toUpperCase() === CRON_NO_REPLY;
}

/**
 * Lời dặn gửi agent khi tới giờ của lịch có gửi kết quả: agent biết câu trả lời
 * sẽ thành tin nhắn chủ động tới người đã nhờ đặt lịch.
 */
export function framePrompt(job: { name: string; prompt: string }, origin: CronOrigin, now: Date, timezone: string): string {
  const who = (origin.kind === "channel" ? origin.senderName : origin.userName) || "người dùng";
  const where =
    origin.kind === "channel"
      ? `${origin.peerKind === "group" ? "nhóm chat trên " : ""}${origin.channelName ?? origin.channelKind}`
      : "trang Chat";
  return [
    `[Lịch hẹn "${job.name}" — tới giờ chạy lúc ${formatInZone(now, timezone)}]`,
    `Việc cần làm: ${job.prompt}`,
    "",
    `Câu trả lời của bạn sẽ được gửi NGUYÊN VĂN tới ${who} (${where}) như một tin nhắn chủ động — họ không vừa nhắn gì cho bạn.`,
    "Viết thẳng cho họ, ngắn gọn, mở đầu để họ biết đây là lời nhắc / báo cáo đã hẹn. Không hỏi lại, không nhắc tên tool.",
    `Nếu lần này không có gì cần báo (vd việc chỉ yêu cầu báo khi có thay đổi mà không có gì mới), trả lời đúng một từ: ${CRON_NO_REPLY}`,
  ].join("\n");
}

type Prepared =
  | {
      ok: true;
      ctx: WorkspaceContext;
      /** Vai trò hiện tại của người đặt lịch trên web. */
      role?: WorkspaceRole;
      /** Kênh để gửi kết quả (lịch tạo trong kênh chat, có gửi). */
      channel?: Channel;
    }
  | { ok: false; reason: string; disable: boolean };

/**
 * Chạy nền: định kỳ lấy các cron job tới hạn (atomic claim) và thực thi qua lane
 * "cron" của Scheduler. Lịch agent tạo khi chat chạy bằng đúng thư mục + quyền
 * HIỆN TẠI của người nhờ đặt lịch và gửi kết quả về cuộc trò chuyện đó. Sau mỗi
 * lần chạy: ghi log + tính next_run (one-shot đã qua → tắt).
 */
export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduler: Scheduler;
  private stopping = false;
  /**
   * Job đang chạy. Claim chỉ ghi last_run, next_run đổi khi chạy XONG → lượt
   * dài hơn chu kỳ poll (20s) sẽ bị claim lại; không chặn là nhắc 2 lần.
   */
  private inFlight = new Set<string>();

  constructor(private rt: RuntimeDeps) {
    this.scheduler = new Scheduler({ cron: 2 });
  }

  start(): void {
    // chạy 1 lần ngay, rồi định kỳ
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.scheduler.drain(15_000);
  }

  /** Lấy các job tới hạn, chạy và chờ tất cả xong (test + chạy tay). */
  async runDueNow(): Promise<void> {
    await Promise.all(await this.dispatchDue());
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    await this.dispatchDue();
  }

  private async dispatchDue(): Promise<Array<Promise<void>>> {
    let due: DueCronJob[];
    try {
      due = await claimDueCronJobs(this.rt.db.db, new Date(), BATCH);
    } catch (err) {
      logger.warn(`CronRunner: lỗi lấy job — ${(err as Error).message}`);
      return [];
    }
    const runs: Array<Promise<void>> = [];
    for (const job of due) {
      if (this.inFlight.has(job.id)) continue; // lượt trước của job này chưa xong
      this.inFlight.add(job.id);
      runs.push(
        this.scheduler
          .schedule("cron", () => this.runJob(job), `cron:${job.id}`)
          .catch((e) => logger.error(`Cron "${job.name}" lỗi: ${(e as Error).message}`))
          .finally(() => this.inFlight.delete(job.id)),
      );
    }
    return runs;
  }

  /** Kiểm tra lịch agent tạo khi chat còn được phép chạy/gửi không. */
  private async prepare(job: CronJobRow, origin: CronOrigin | null): Promise<Prepared> {
    const { db } = this.rt.db;
    const sysCtx = systemContext(job.workspaceId);
    if (!origin) return { ok: true, ctx: sysCtx };

    if (origin.kind === "web") {
      const role = await getActiveMemberRole(db, sysCtx, origin.userId);
      if (!role || !canChat(role)) {
        return { ok: false, reason: "Người đặt lịch không còn trong workspace, bị khóa hoặc hết quyền chat — lịch được tắt.", disable: true };
      }
      const ctx: WorkspaceContext = { workspaceId: job.workspaceId, userId: origin.userId, role };
      if (role === "member" && !(await canAccessAgent(db, ctx, job.agentId))) {
        return { ok: false, reason: "Người đặt lịch không còn được dùng agent này — lịch được tắt.", disable: true };
      }
      return { ok: true, ctx, role };
    }

    const ch = await getChannelById(db, sysCtx, origin.channelId);
    if (!ch) return { ok: false, reason: "Kênh chat của lịch đã bị xóa — lịch được tắt.", disable: true };
    if (ch.requirePairing && !(await isPaired(db, sysCtx, ch.id, origin.senderId))) {
      return { ok: false, reason: "Người đặt lịch không còn được duyệt trên kênh — lịch được tắt.", disable: true };
    }
    if (!origin.deliver) return { ok: true, ctx: sysCtx };
    if (!ch.enabled) return { ok: false, reason: `Kênh "${ch.name}" đang tạm dừng — bỏ qua lượt này.`, disable: false };
    const channel = channelHandlers.get(ch.id)?.channel;
    if (!channel || !channel.isRunning()) {
      return { ok: false, reason: `Kênh "${ch.name}" chưa sẵn sàng gửi tin — bỏ qua lượt này.`, disable: false };
    }
    return { ok: true, ctx: sysCtx, channel };
  }

  private async runJob(due: DueCronJob): Promise<void> {
    const { db } = this.rt.db;
    const sysCtx = systemContext(due.workspaceId);
    const claimedAt = Date.now();
    const job = await getCronJob(db, sysCtx, due.id).catch(() => null);
    if (!job) return; // vừa bị xóa
    const origin = job.origin ?? null;
    const tz = job.timezone ?? this.rt.config.timezone;
    let status: "ok" | "error" = "ok";
    let output = "";
    let disable = false;

    const prep = await this.prepare(job, origin).catch(
      (err): Prepared => ({ ok: false, reason: (err as Error).message, disable: false }),
    );
    if (!prep.ok) {
      status = "error";
      output = prep.reason;
      disable = prep.disable;
      logger.warn(`Cron "${job.name}": ${prep.reason}`);
    } else {
      const runCtx = prep.ctx;
      let sessionId: string | null = null;
      try {
        const agent = await getAgentById(db, runCtx, job.agentId);
        if (!agent) throw new Error("Agent không tồn tại");
        const webOrigin = origin?.kind === "web" ? origin : null;
        const session = await createSession(db, runCtx, {
          agentId: job.agentId,
          title: webOrigin?.deliver ? `⏰ ${job.name}` : `cron:${job.name}`,
          ...(webOrigin ? { ownerUserId: webOrigin.userId } : {}),
        });
        sessionId = session.id;
        let collector: ReturnType<typeof createOutboundCollector> | null = null;
        const loopDeps = await buildLoopDeps(this.rt, runCtx, agent.provider, {
          ...agentOpts(agent),
          sourceKind: "cron",
          // Quyền của người đặt lịch: web theo vai trò HIỆN TẠI, kênh = người ngoài
          accessRole: webOrigin ? prep.role! : null,
          ...(job.ownerKey ? { userKey: job.ownerKey } : {}),
          ...(webOrigin ? { skipUserMcpLayer: prep.role !== "member" } : {}),
          ...(origin?.principalId ? { principalId: origin.principalId } : {}),
          ...(origin?.kind === "channel" && origin.channelIdentityId
            ? { channelIdentityId: origin.channelIdentityId }
            : {}),
          ...(origin?.kind === "channel" && origin.conversationId ? { conversationId: origin.conversationId } : {}),
          // Kết quả gửi thẳng cho người đó → nạp hồ sơ + cách xưng hô của họ
          ...(origin?.deliver
            ? {
                person:
                  origin.kind === "channel"
                    ? { channelKind: origin.channelKind, peerKind: origin.peerKind }
                    : { channelKind: "web", peerKind: "direct" as const },
              }
            : {}),
          ...(origin?.deliver ? { attachFile: (p: string) => collector?.attachFile(p) } : {}),
        });
        if (origin?.deliver) {
          collector = createOutboundCollector(
            loopDeps.workDir ?? loopDeps.workspaceDataDir,
            loopDeps.sharedDir ?? loopDeps.workspaceDataDir,
          );
          await collector.begin();
        }
        const effort = reasoningEffortOf(agent);
        let streamed = "";
        let finalText = "";
        let iterations = 0;
        let usage = { inputTokens: 0, outputTokens: 0 };
        let runError: string | null = null;
        const started = Date.now();
        try {
          for await (const ev of runAgent(loopDeps, {
            ctx: runCtx,
            agent: {
              systemPrompt: agent.systemPrompt,
              model: agent.model,
              maxIterations: agent.maxIterations,
              ...(effort ? { reasoningEffort: effort } : {}),
            },
            sessionId: session.id,
            userMessage: origin?.deliver ? framePrompt(job, origin, new Date(), tz) : job.prompt,
          })) {
            if (ev.type === "text_delta") streamed += ev.text;
            else if (ev.type === "tool_result") collector?.noteToolResult(ev.result);
            else if (ev.type === "done") {
              finalText = ev.finalText || streamed;
              iterations = ev.iterations;
              usage = ev.usage;
            } else if (ev.type === "error") {
              throw new Error(ev.message);
            }
          }
        } catch (err) {
          runError = (err as Error).message;
          throw err;
        } finally {
          recordTraceSafe(db, runCtx, {
            agentId: job.agentId,
            sessionId: session.id,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            iterations,
            durationMs: Date.now() - started,
            source: "cron",
            model: agent.model,
            provider: agent.provider,
            kind: "cron",
            ...(runError ? { error: runError.slice(0, 500) } : {}),
          });
        }
        output = finalText;
        logger.info(`Cron "${job.name}" chạy xong (${iterations} vòng)`);

        if (origin?.deliver) {
          const text = finalText.replace(MEDIA_MARKER_RE, "").trim();
          const media = collector ? await collector.finish() : [];
          output = await this.deliver(job, origin, prep, session.id, isNoReply(text) ? "" : text, media);
          if (text && !isNoReply(text)) output = `${text}\n\n— ${output}`;
        }
      } catch (err) {
        status = "error";
        output = (err as Error).message;
        if (origin?.deliver) {
          await this.notifyFailure(job, origin, prep, sessionId, output, tz).catch((e) =>
            logger.warn(`Cron "${job.name}": báo lỗi cho người dùng thất bại — ${(e as Error).message}`),
          );
        }
      }
    }

    try {
      await recordCronRun(db, sysCtx, job.id, status, output);
      // Lịch vừa được sửa trong lúc chạy (đổi giờ, bật lại) → giữ lần chạy mới đã tính
      const fresh = await getCronJob(db, sysCtx, job.id);
      if (!fresh) return;
      if (!disable && fresh.nextRun.getTime() > claimedAt) return;
      let next = disable ? null : nextRun(fresh.schedule, new Date(), fresh.timezone);
      // Lời nhắc một lần gặp lỗi tạm thời (kênh đang khởi động lại...) → thử lại
      // mỗi phút trong 30 phút tính từ giờ hẹn, thay vì bỏ luôn lời nhắc.
      if (!next && !disable && !prep.ok) {
        const dueAt = nextRun(fresh.schedule, new Date(0), fresh.timezone);
        if (dueAt && Date.now() - dueAt.getTime() < ONE_SHOT_RETRY_MS) next = new Date(Date.now() + 60_000);
      }
      await updateCronNextRun(db, job.id, next, next === null);
    } catch (err) {
      logger.warn(`Cron "${job.name}": cập nhật next_run lỗi — ${(err as Error).message}`);
    }
  }

  /** Gửi kết quả về nơi đặt lịch. Trả mô tả để ghi vào cron_runs. */
  private async deliver(
    job: CronJobRow,
    origin: CronOrigin,
    prep: Extract<Prepared, { ok: true }>,
    runSessionId: string,
    text: string,
    media: string[],
  ): Promise<string> {
    const { db } = this.rt.db;
    if (!text && !media.length) return "không gửi tin (không có gì cần báo)";

    if (origin.kind === "web") {
      // Phiên "⏰ <tên lịch>" của chính người đó đã có câu trả lời; thêm thẻ file để tải
      if (media.length) {
        const out = await describeOutbound(media, webDirs(this.rt.config.dataDir, prep.ctx));
        if (out.length) {
          await appendMessage(db, prep.ctx, runSessionId, {
            role: "assistant",
            content: {
              kind: "assistant",
              text: `📎 Đã gửi file: ${out.map((f) => f.name).join(", ")}\n${filesMarker(out)}`,
              toolCalls: [],
            },
          });
        }
      }
      return "đã lưu vào trang Chat của người đặt lịch";
    }

    const channel = prep.channel;
    if (!channel) throw new Error("Kênh chưa sẵn sàng gửi tin");
    await channel.send({ chatKey: origin.chatKey, text, ...(media.length ? { media } : {}) });
    // Ghi vào hội thoại hiện tại của chat đó để người dùng trả lời tiếp thì agent
    // biết vừa nhắc gì. Xếp hàng theo session như tin thường — chèn giữa một lượt
    // đang chạy (giữa tool call và kết quả) sẽ làm hỏng lịch sử gửi cho model.
    const sid = await getChannelSession(db, prep.ctx, origin.channelId, origin.chatKey);
    if (sid) {
      const note =
        `⏰ [Lịch hẹn "${job.name}"]\n${text}` +
        (media.length ? `\n📎 ${media.map((p) => basename(p)).join(", ")}` : "");
      await scheduleOnChannelQueue(sid, () =>
        appendMessage(db, prep.ctx, sid, {
          role: "assistant",
          content: { kind: "assistant", text: note, toolCalls: [] },
        }),
      ).catch((err) => logger.warn(`Cron "${job.name}": ghi vào hội thoại lỗi — ${(err as Error).message}`));
    }
    return `đã gửi tới ${origin.channelName ?? origin.channelKind}${origin.senderName ? ` · ${origin.senderName}` : ""}`;
  }

  /**
   * Lượt chạy lỗi (mô hình AI lỗi, hết hạn mức...) → báo người dùng, nhưng chỉ
   * lần lỗi ĐẦU của một chuỗi lỗi (lịch lặp mỗi 5 phút không được spam lỗi).
   * Lịch một lần kèm luôn nội dung đã hẹn để người dùng vẫn nhận được lời nhắc.
   */
  private async notifyFailure(
    job: CronJobRow,
    origin: CronOrigin,
    prep: Extract<Prepared, { ok: true }>,
    sessionId: string | null,
    error: string,
    tz: string,
  ): Promise<void> {
    const { db } = this.rt.db;
    const last = await listCronRuns(db, prep.ctx, job.id, 1);
    if (last[0]?.status === "error") return;
    const once = /^at\s/i.test(job.schedule.trim());
    const text =
      `⚠️ Lịch "${job.name}" chưa chạy được lúc ${formatInZone(new Date(), tz)} (lỗi: ${error.slice(0, 200)}).` +
      (once ? `\nNội dung đã hẹn: ${job.prompt.slice(0, 500)}` : "\nHệ thống sẽ thử lại ở lần chạy kế tiếp.");
    if (origin.kind === "channel") {
      await prep.channel?.send({ chatKey: origin.chatKey, text });
    } else if (sessionId) {
      await appendMessage(db, prep.ctx, sessionId, {
        role: "assistant",
        content: { kind: "assistant", text, toolCalls: [] },
      });
    }
  }
}
