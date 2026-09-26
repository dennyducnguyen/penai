import { logger } from "@penai/shared";
import type { WorkspaceContext } from "@penai/shared";
import {
  addMemory,
  getAgentById,
  getSessionChannelUserKey,
  listSessionsNeedingConsolidation,
  loadMessages,
  type MemoryRow,
} from "@penai/db";
import type { RuntimeDeps } from "./agent-runtime.js";
import { systemContext } from "./agent-runtime.js";

/**
 * Tóm tắt 1 session đã nguội thành memory episodic (trí nhớ theo sự kiện).
 * Dùng chung cho endpoint /v1/sessions/:id/consolidate và worker nền.
 * userKey: session kênh → scope theo người dùng đó (không rò sang người khác).
 */
export async function consolidateSession(
  rt: RuntimeDeps,
  ctx: WorkspaceContext,
  sessionId: string,
  agent: { id: string; provider: string; model: string },
): Promise<
  | { ok: true; memory: MemoryRow | null; note?: string }
  | { ok: false; code: number; error: string }
> {
  const { db } = rt.db;
  const msgs = await loadMessages(db, ctx, sessionId);
  const convo = msgs
    .map((m) => {
      // Phân vai theo m.role, không theo content.kind — nếu không, message
      // hệ thống bị gán nhãn "User:" và lọt vào bản tóm tắt.
      const c = m.content as { kind: string; text?: string; result?: string };
      if (m.role === "user" && c.kind === "text") return `User: ${c.text}`;
      if (m.role === "assistant" && c.kind === "assistant" && c.text) {
        return `Assistant: ${c.text}`;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n");
  if (!convo) return { ok: false, code: 400, error: "Session chưa có nội dung" };

  let provider;
  try {
    provider = rt.providers.get(agent.provider, ctx.workspaceId);
  } catch (err) {
    return { ok: false, code: 500, error: (err as Error).message };
  }
  const res = await provider.chat({
    model: agent.model,
    system:
      "Bạn là trợ lý tóm tắt. Hãy tóm tắt hội thoại sau thành 2-4 câu ngắn gọn, " +
      "giữ lại thông tin quan trọng, sở thích, quyết định, sự kiện. Chỉ trả về bản tóm tắt.",
    messages: [{ role: "user", content: convo.slice(0, 12000) }],
    maxTokens: 400,
  });
  const summary = res.content?.trim();
  if (!summary) return { ok: false, code: 502, error: "LLM không trả tóm tắt" };
  // Provider echo (mock-llm) hoặc model không tóm tắt mà chép lại hội thoại →
  // lưu vào bộ nhớ sẽ thành rác kiểu "Bạn nói: User: ... Assistant: ...".
  if (/^Bạn nói:/i.test(summary) || /(^|\n)(User|Assistant):\s/.test(summary)) {
    return {
      ok: false,
      code: 422,
      error:
        "Model không tóm tắt được (trả về nguyên hội thoại) — đổi agent sang model thật rồi thử lại",
    };
  }
  // Session kênh → memory episodic scope theo người dùng của kênh đó
  const userKey = await getSessionChannelUserKey(db, ctx, sessionId).catch(() => null);
  const mem = await addMemory(db, ctx, {
    agentId: agent.id,
    tier: "episodic",
    content: summary,
    importance: 0.6,
    sourceSessionId: sessionId,
    ...(userKey ? { userKey } : {}),
  });
  // addMemory trả null khi trùng nội dung (consolidate 2 lần cùng session)
  if (!mem) return { ok: true, memory: null, note: "Đã có ghi nhớ trùng nội dung, bỏ qua" };
  return { ok: true, memory: mem };
}

const POLL_MS_DEFAULT = 15 * 60_000; // 15 phút
const IDLE_MINUTES = 30; // session "nguội" sau 30 phút không có tin nhắn
const MIN_MESSAGES = 4;
const MAX_AGE_DAYS = 7;
const BATCH = 10;

/**
 * Worker nền: định kỳ tìm session đã nguội (idle đủ lâu, đủ nội dung, chưa có
 * memory episodic mới hơn tin nhắn cuối) và tự tóm tắt thành memory.
 * Tắt bằng PENAI_MEMORY_WORKER=off; đổi chu kỳ bằng PENAI_MEMORY_WORKER_MIN.
 */
export class MemoryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;
  /** Session lỗi vĩnh viễn (model không tóm tắt được) — bỏ qua trong đời tiến trình. */
  private skip = new Set<string>();

  constructor(private rt: RuntimeDeps) {}

  start(): void {
    if (process.env.PENAI_MEMORY_WORKER === "off") {
      logger.info("MemoryWorker: tắt qua PENAI_MEMORY_WORKER=off");
      return;
    }
    const min = Number(process.env.PENAI_MEMORY_WORKER_MIN);
    const pollMs = Number.isFinite(min) && min >= 1 ? min * 60_000 : POLL_MS_DEFAULT;
    this.timer = setInterval(() => void this.tick(), pollMs);
    logger.info(`MemoryWorker: tự tóm tắt session mỗi ${Math.round(pollMs / 60_000)} phút`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** 1 vòng quét — public để test/gọi tay. */
  async tick(): Promise<{ consolidated: number; failed: number }> {
    if (this.running || this.stopping) return { consolidated: 0, failed: 0 };
    this.running = true;
    let consolidated = 0;
    let failed = 0;
    try {
      const due = await listSessionsNeedingConsolidation(this.rt.db.db, {
        idleMinutes: IDLE_MINUTES,
        minMessages: MIN_MESSAGES,
        maxAgeDays: MAX_AGE_DAYS,
        limit: BATCH,
      });
      for (const s of due) {
        if (this.stopping) break;
        if (this.skip.has(s.sessionId)) continue;
        const ctx = systemContext(s.workspaceId);
        try {
          const agent = await getAgentById(this.rt.db.db, ctx, s.agentId);
          if (!agent) continue;
          const r = await consolidateSession(this.rt, ctx, s.sessionId, agent);
          if (r.ok) {
            consolidated++;
            if (r.memory) {
              logger.info(`MemoryWorker: đã tóm tắt session ${s.sessionId.slice(0, 8)}`);
            }
          } else {
            failed++;
            // 400/422 sẽ lặp lại mãi với cùng session → bỏ qua các lần sau
            if (r.code === 422 || r.code === 400) this.skip.add(s.sessionId);
            else logger.warn(`MemoryWorker: session ${s.sessionId.slice(0, 8)} lỗi — ${r.error}`);
          }
        } catch (err) {
          failed++;
          logger.warn(`MemoryWorker: session ${s.sessionId.slice(0, 8)} lỗi — ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.warn(`MemoryWorker: lỗi quét — ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
    return { consolidated, failed };
  }
}
