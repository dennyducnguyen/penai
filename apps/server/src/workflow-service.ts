/**
 * Quy trình tự động — phần máy chủ: tạo/sửa/phiên bản, danh mục (kênh, tool, MCP,
 * agent), chạy (thay mặt người sở hữu quy trình), bộ chạy theo lịch, và "host"
 * nối engine (packages/core/src/workflow) với kênh chat, tool, MCP, agent.
 *
 * Dùng chung cho Dashboard/API (workflow-routes.ts), tool workflow_* của agent
 * (workflow-tools.ts) và PenAI MCP server (mcp-server.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  decryptSecret,
  encryptSecret,
  hasRole,
  logger,
  type WorkspaceContext,
  type WorkspaceRole,
} from "@penai/shared";
import {
  addWorkflowRunSteps,
  appendMessage,
  claimDueWorkflows,
  countEnabledWorkflows,
  createSession,
  createWorkflow,
  createWorkflowRun,
  deleteWorkflow,
  failInterruptedWorkflowRuns,
  finishWorkflowRun,
  getActiveMemberRole,
  getAgentByKey,
  getChannelSession,
  getWorkflow,
  getWorkflowBySlug,
  getWorkflowRun,
  getWorkflowVersion,
  getWorkspaceSecretMeta,
  checkWsdbSql,
  listAgents,
  listChannels,
  listCustomTools,
  listInboxThreads,
  listRecentChannelChats,
  listWorkflows,
  listWorkflowsNeedingSchedule,
  listWorkspaceSecrets,
  listWorkspaceSecretValues,
  pruneWorkflowData,
  recordAudit,
  recordTraceSafe,
  releaseRunLocks,
  releaseWorkflowLock,
  saveWorkflowVersion,
  scrubWorkflowRunSteps,
  SecretNotWritableError,
  setWorkflowNextRun,
  tryAcquireWorkflowLock,
  updateWorkflowMeta,
  workflowDeleteSecret,
  workflowWriteSecret,
  wsdbSchemaName,
  type WorkflowChangeVia,
  type WorkflowRow,
} from "@penai/db";
import {
  applyOps,
  diffDefinitions,
  formatIssues,
  maskSecrets,
  nextRun,
  runAgentText,
  runWorkflow,
  scheduleOf,
  STEP_INFO,
  validateDefinition,
  walkSteps,
  type RunResult,
  type StepLog,
  type ValidationIssue,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type WorkflowHost,
  type WorkflowOp,
} from "@penai/core";
import { createDefaultToolRegistry, isUrlAllowed, slugify, type ToolContext } from "@penai/tools";
import { isPersonalChannelKind } from "@penai/channels";
import { agentOpts, buildLoopDeps, buildWorkspaceRegistry, reasoningEffortOf, systemContext, type RuntimeDeps } from "./agent-runtime.js";
import { channelHandlers, scheduleOnChannelQueue } from "./channels-runtime.js";
import { execSandboxFor } from "./library-paths.js";
import { createOutboundCollector } from "./web-chat.js";
import { allowForRole, getWsdbService } from "./wsdb-service.js";

const MEDIA_RE = /\[\[media:([^\]]+)\]\]/g;
const HTTP_MAX_BYTES = 5 * 1024 * 1024;
const POLL_MS = 20_000;

export interface WorkflowActor {
  ctx: WorkspaceContext;
  via: WorkflowChangeVia;
  /** Agent đang chat (via = agent). */
  agentId?: string;
  /** Tên hiển thị trong nhật ký lần chạy ("bấm tay bởi …"). */
  label?: string;
}

export class WorkflowError extends Error {
  constructor(
    message: string,
    public status = 400,
    public issues: ValidationIssue[] = [],
    public warnings: ValidationIssue[] = [],
  ) {
    super(message);
  }
}

export interface RunRequest {
  inputs?: Record<string, unknown>;
  triggerType: "schedule" | "webhook" | "manual" | "agent" | "api" | "mcp" | "subworkflow" | "test";
  trigger?: Record<string, unknown>;
  test?: boolean;
  dryRun?: boolean;
  parentRunId?: string;
  depth?: number;
  /** Bỏ qua kiểm tra "đang tắt" (bấm tay / chạy thử vẫn được khi quy trình tắt). */
  allowDisabled?: boolean;
  onRespond?: (res: { status: number; headers: Record<string, string>; body: unknown }) => void;
}

export interface StartedRun {
  runId: string;
  done: Promise<RunResult>;
}

/** Hàng đợi đơn giản: tối đa N lần chạy cùng lúc trên toàn hệ thống. */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private limit: () => number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit()) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
  get running(): number {
    return this.active;
  }
}

/** Thư mục file của quy trình — trùng thư mục làm việc của agent khi quy trình nhờ agent. */
export function workflowUserKey(workflowId: string): string {
  return `workflow-${workflowId}`;
}

export class WorkflowService {
  private sem: Semaphore;
  private inFlight = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private running = new Map<string, AbortController>();
  private stopping = false;

  constructor(private rt: RuntimeDeps) {
    this.sem = new Semaphore(() => rt.config.workflows.maxConcurrentRuns);
  }

  get cfg() {
    return this.rt.config.workflows;
  }

  get publicBase(): string {
    return (process.env.PENAI_PUBLIC_URL ?? `http://127.0.0.1:${this.rt.config.port}`).replace(/\/$/, "");
  }

  private get db() {
    return this.rt.db.db;
  }

  private limits() {
    return {
      maxSteps: this.cfg.maxSteps,
      maxLoop: this.cfg.maxLoop,
      maxRunSeconds: this.cfg.maxRunSeconds,
      allowShell: this.cfg.allowShell,
    };
  }

  // ======================= danh mục =======================

  /** Danh mục đầy đủ (UI + AI): kênh + cuộc trò chuyện gần đây, tool, MCP, agent, quy trình, khóa bí mật. */
  async catalog(ctx: WorkspaceContext, kind?: string) {
    const want = (k: string) => !kind || kind === k;
    const out: Record<string, unknown> = {};
    if (want("channels")) {
      const chans = await listChannels(this.db, ctx);
      const recent = await listRecentChannelChats(this.db, ctx, 300).catch(() => []);
      const channels = [];
      for (const c of chans) {
        let chats: Array<{ to: string; title: string }> = recent
          .filter((r) => r.channelId === c.id)
          .slice(0, 30)
          .map((r) => ({ to: r.chatKey, title: r.title.replace(/^[a-z_]+:/, "") }));
        if (isPersonalChannelKind(c.kind)) {
          try {
            const t = await listInboxThreads(this.db, ctx, c.id, { limit: 40, withMessagesOnly: true });
            const seen = new Set(chats.map((x) => x.to));
            for (const th of t.threads) {
              const to = `${th.kind}:${th.threadId}`;
              if (!seen.has(to)) chats.push({ to, title: `${th.kind === "group" ? "👥 " : ""}${th.contactAlias || th.name || th.threadId}` });
            }
          } catch {
            // bỏ qua
          }
        }
        chats = chats.slice(0, 50);
        channels.push({
          id: c.id,
          ref: `${c.kind}:${c.name}`,
          kind: c.kind,
          name: c.name,
          enabled: c.enabled,
          running: channelHandlers.get(c.id)?.channel.isRunning() ?? false,
          chats,
          toHint: isPersonalChannelKind(c.kind)
            ? '"direct:<uid>" (người) hoặc "group:<id nhóm>"'
            : c.kind === "telegram"
              ? "chat id Telegram (số; nhóm là số âm)"
              : "chatKey của cuộc trò chuyện (xem danh sách chats)",
        });
      }
      out.channels = channels;
    }
    if (want("tools")) {
      const reg = createDefaultToolRegistry();
      const customs = await listCustomTools(this.db, ctx).catch(() => []);
      const customNames = new Set(customs.map((c) => c.name));
      const hidden = new Set(["cron_create", "cron_list", "cron_update", "cron_delete", "delegate_task", "send_file", "send_approval_card"]);
      out.tools = [
        ...reg
          .definitions()
          .filter((t) => !hidden.has(t.name) && !t.name.startsWith("team_") && !t.name.startsWith("workflow_") && !t.name.startsWith("db_"))
          .map((t) => ({ name: t.name, description: t.description.slice(0, 300), parameters: t.parameters, custom: false, requiresApproval: t.name === "exec" })),
        ...customs
          .filter((c) => c.enabled)
          .map((c) => ({ name: c.name, description: c.description, parameters: c.paramsSchema, custom: true, requiresApproval: c.requiresApproval })),
      ].filter((t, i, arr) => arr.findIndex((x) => x.name === t.name) === i || customNames.has(t.name));
    }
    if (want("mcp")) out.mcp = this.rt.mcp?.catalogFor(ctx.workspaceId) ?? [];
    if (want("agents")) {
      const agents = await listAgents(this.db, ctx);
      out.agents = agents.map((a) => ({ key: a.key, name: a.name, provider: a.provider, model: a.model }));
    }
    if (want("workflows")) {
      const wfs = await listWorkflows(this.db, ctx);
      out.workflows = wfs.map((w) => ({ id: w.id, slug: w.slug, name: w.name, enabled: w.enabled }));
    }
    if (want("secrets")) out.secrets = (await listWorkspaceSecrets(this.db, ctx)).map((s) => ({ name: s.name, note: s.note }));
    if (want("steps")) out.stepTypes = STEP_INFO;
    if (want("database") && this.rt.config.workspaceDb.enabled) {
      try {
        const sch = await getWsdbService(this.rt).schema(ctx);
        out.database = {
          tables: sch.tables.map((t) => ({
            name: t.name,
            kind: t.kind,
            comment: t.comment,
            rows: t.rowsEstimate,
            primaryKey: t.primaryKey,
            columns: t.columns.map((c) => ({ name: c.name, type: c.type, primaryKey: c.primaryKey, unique: c.unique, identity: c.identity, notNull: c.notNull, hasDefault: c.default !== null })),
          })),
        };
      } catch (e) {
        out.database = { tables: [], error: (e as Error).message };
      }
    }
    return out;
  }

  /** Danh mục rút gọn dùng cho validator (kiểm tên kênh/tool/MCP/agent). */
  private async validatorCatalog(ctx: WorkspaceContext): Promise<WorkflowCatalog> {
    const c = (await this.catalog(ctx)) as {
      channels: Array<{ id: string; name: string; kind: string; ref: string }>;
      tools: Array<{ name: string }>;
      mcp: Array<{ serverId: string; serverName: string; tools: Array<{ name: string }> }>;
      agents: Array<{ key: string }>;
      workflows: Array<{ id: string; slug: string }>;
      secrets: Array<{ name: string }>;
      database?: { tables: Array<{ name: string }>; error?: string };
    };
    return {
      channels: c.channels,
      tools: c.tools.map((t) => t.name),
      // MCP chưa kết nối (đang khởi động lại) → không chặn lưu, chỉ kiểm khi có danh sách
      ...(this.rt.mcp ? { mcp: c.mcp.map((m) => ({ id: m.serverId, name: m.serverName, tools: m.tools.map((t) => t.name) })) } : {}),
      agents: c.agents.map((a) => a.key),
      workflows: c.workflows,
      secrets: c.secrets.map((s) => s.name),
      ...(c.database && !c.database.error ? { tables: c.database.tables.map((t) => t.name) } : {}),
    };
  }

  // ======================= kiểm tra + lưu =======================

  /**
   * lenientRefs: quy trình đang TẮT (tạo từ mẫu, nhập JSON, bản nháp) → tên kênh / agent /
   * tool / MCP / quy trình / khóa bí mật chưa đúng chỉ là cảnh báo; bật lên mới kiểm chặt.
   */
  async validate(ctx: WorkspaceContext, input: unknown, opts: { lenientRefs?: boolean } = {}) {
    const catalog = await this.validatorCatalog(ctx);
    const res = await validateDefinition(input, { limits: this.limits(), catalog, timezone: this.rt.config.timezone });
    // Bước db viết SQL: kiểm bằng bộ phân tích SQL thật (cú pháp + lệnh bị chặn) ngay lúc lưu
    {
      const schema = wsdbSchemaName(ctx.workspaceId);
      const jobs: Array<{ label: string; sql: string; confirm: boolean }> = [];
      walkSteps(res.definition.steps ?? [], (st, path) => {
        if (st && st.type === "db" && typeof st.sql === "string" && st.sql.trim() && !st.sql.includes("{{")) {
          jobs.push({ label: `${path} (${st.id})`, sql: st.sql, confirm: st.confirm === true });
        }
      });
      for (const j of jobs) {
        try {
          const chk = await checkWsdbSql(j.sql, schema);
          if (chk.destructive && !j.confirm) {
            res.errors.push({ path: `${j.label}.sql`, message: "Câu lệnh có thể xóa nhiều dữ liệu (DROP, TRUNCATE, DELETE/UPDATE không WHERE, xóa cột) — thêm WHERE, hoặc đặt \"confirm\": true nếu đúng ý" });
          }
        } catch (e) {
          res.errors.push({ path: `${j.label}.sql`, message: (e as Error).message });
        }
      }
      res.ok = res.errors.length === 0;
    }
    if (opts.lenientRefs) {
      const REF = /^(Kênh ".*" không tồn tại|Tool ".*" không có|MCP server ".*" không có|MCP ".*" không có tool|Agent ".*" không có|Quy trình ".*" không có|Khóa bí mật secrets\.)/;
      const keep: ValidationIssue[] = [];
      for (const e of res.errors) {
        if (REF.test(e.message.normalize("NFC"))) res.warnings.push({ path: e.path, message: `${e.message} — sửa trước khi bật quy trình` });
        else keep.push(e);
      }
      res.errors = keep;
      res.ok = keep.length === 0;
    }
    // MCP server có trong DB nhưng chưa kết nối → hạ lỗi thành cảnh báo
    const mcpNames = new Set((catalog.mcp ?? []).map((m) => m.name.toLowerCase()));
    if (!mcpNames.size) {
      const keep: ValidationIssue[] = [];
      for (const e of res.errors) {
        if (/MCP server ".*" không có/.test(e.message)) res.warnings.push({ path: e.path, message: `${e.message} (MCP chưa kết nối — kiểm lại sau)` });
        else keep.push(e);
      }
      res.errors = keep;
      res.ok = keep.length === 0;
    }
    return res;
  }

  /**
   * Agent/MCP không tự "duyệt" được bước cần duyệt (tool requiresApproval, shell):
   * cờ approved chỉ giữ khi bản trước đã có đúng bước đó (cùng id + loại + tool/lệnh)
   * và đã được duyệt.
   */
  private enforceApprovals(def: WorkflowDefinition, prev: WorkflowDefinition | null, via: WorkflowChangeVia): string[] {
    if (via !== "agent" && via !== "mcp") return [];
    const prevApproved = new Map<string, string>();
    if (prev) {
      walkSteps(prev.steps ?? [], (s) => {
        if (s.approved === true) prevApproved.set(s.id, JSON.stringify([s.type, s.tool, s.command]));
      });
    }
    const stripped: string[] = [];
    walkSteps(def.steps ?? [], (s) => {
      if (s.approved === true && prevApproved.get(s.id) !== JSON.stringify([s.type, s.tool, s.command])) {
        s.approved = false;
        stripped.push(s.id);
      }
    });
    return stripped;
  }

  private async approvalWarnings(ctx: WorkspaceContext, def: WorkflowDefinition): Promise<ValidationIssue[]> {
    const customs = await listCustomTools(this.db, ctx).catch(() => []);
    const needs = new Set(customs.filter((c) => c.requiresApproval).map((c) => c.name));
    needs.add("exec");
    const out: ValidationIssue[] = [];
    walkSteps(def.steps ?? [], (s, path) => {
      const need = (s.type === "tool" && typeof s.tool === "string" && needs.has(s.tool)) || s.type === "shell";
      if (need && s.approved !== true) {
        out.push({
          path: `${path} (${s.id})`,
          message: 'Bước này cần quản trị viên tick "Cho phép chạy không cần duyệt" trên Dashboard (Quy trình → bước này) — chưa tick thì chạy sẽ bị từ chối',
        });
      }
    });
    return out;
  }

  computeNextRun(def: WorkflowDefinition, enabled: boolean, from = new Date()): Date | null {
    if (!enabled) return null;
    let best: Date | null = null;
    for (const t of def.triggers ?? []) {
      const s = scheduleOf(t);
      if (!s) continue;
      const tz = (t.type === "schedule" && t.timezone) || this.rt.config.timezone;
      try {
        const n = nextRun(s, from, tz);
        if (n && (!best || n < best)) best = n;
      } catch {
        // lịch hỏng đã bị validator chặn
      }
    }
    return best;
  }

  private async uniqueSlug(ctx: WorkspaceContext, name: string, wanted?: string): Promise<string> {
    const base = slugify(wanted || name) || "quy-trinh";
    let slug = base;
    for (let i = 2; await getWorkflowBySlug(this.db, ctx, slug); i++) slug = `${base}-${i}`.slice(0, 60);
    return slug;
  }

  private async assertEnabledQuota(ctx: WorkspaceContext): Promise<void> {
    const n = await countEnabledWorkflows(this.db, ctx);
    if (n >= this.cfg.maxEnabledPerWorkspace) {
      throw new WorkflowError(`Đã có ${n} quy trình đang bật (tối đa ${this.cfg.maxEnabledPerWorkspace}) — tắt bớt rồi thử lại`, 409);
    }
  }

  async create(
    actor: WorkflowActor,
    input: unknown,
    opts: { enabled?: boolean; slug?: string; note?: string } = {},
  ): Promise<{ row: WorkflowRow; warnings: ValidationIssue[] }> {
    const v = await this.validate(actor.ctx, input, { lenientRefs: opts.enabled === false });
    if (!v.ok) throw new WorkflowError(`Định nghĩa chưa hợp lệ:\n${formatIssues(v.errors)}`, 400, v.errors, v.warnings);
    const def = v.definition;
    const stripped = this.enforceApprovals(def, null, actor.via);
    const enabled = opts.enabled ?? true;
    if (enabled) await this.assertEnabledQuota(actor.ctx);
    const slug = await this.uniqueSlug(actor.ctx, def.name, opts.slug);
    const row = await createWorkflow(this.db, actor.ctx, {
      slug,
      name: def.name,
      description: def.description ?? "",
      enabled,
      ownerUserId: actor.ctx.userId === actor.ctx.workspaceId ? null : actor.ctx.userId,
      definition: def as unknown as Record<string, unknown>,
      webhookTokenEncrypted: encryptSecret(randomBytes(24).toString("base64url")),
      webhookSecretEncrypted: encryptSecret(randomBytes(32).toString("hex")),
      nextRunAt: this.computeNextRun(def, enabled),
      createdVia: actor.via,
      ...(actor.agentId ? { changedByAgentId: actor.agentId } : {}),
      ...(opts.note ? { changeNote: opts.note } : {}),
    });
    await recordAudit(this.db, actor.ctx, "workflow.create", { id: row.id, name: row.name, via: actor.via, ...(actor.agentId ? { agentId: actor.agentId } : {}) });
    const warnings = [...v.warnings, ...(await this.approvalWarnings(actor.ctx, def))];
    for (const id of stripped) warnings.push({ path: id, message: "Cờ approved bị bỏ — chỉ quản trị viên duyệt trên Dashboard" });
    return { row, warnings };
  }

  async update(
    actor: WorkflowActor,
    id: string,
    input: { definition?: unknown; ops?: WorkflowOp[]; note?: string; expectVersion?: number },
  ): Promise<{ row: WorkflowRow; warnings: ValidationIssue[]; diff: ReturnType<typeof diffDefinitions> }> {
    const cur = await this.mustGet(actor.ctx, id);
    const prev = cur.definition as unknown as WorkflowDefinition;
    let next: unknown;
    if (input.definition !== undefined) next = input.definition;
    else if (input.ops?.length) {
      try {
        next = applyOps(prev, input.ops);
      } catch (err) {
        throw new WorkflowError((err as Error).message, 400);
      }
    } else throw new WorkflowError("Cần definition (JSON đầy đủ) hoặc ops (thao tác nhỏ)");
    const v = await this.validate(actor.ctx, next, { lenientRefs: !cur.enabled });
    if (!v.ok) throw new WorkflowError(`Định nghĩa chưa hợp lệ:\n${formatIssues(v.errors)}`, 400, v.errors, v.warnings);
    const def = v.definition;
    const stripped = this.enforceApprovals(def, prev, actor.via);
    const diff = diffDefinitions(prev, def);
    if (!diff.length && def.name === cur.name && (def.description ?? "") === cur.description && JSON.stringify(def) === JSON.stringify(prev)) {
      return { row: cur, warnings: v.warnings, diff };
    }
    const row = await saveWorkflowVersion(this.db, actor.ctx, id, {
      name: def.name,
      description: def.description ?? "",
      definition: def as unknown as Record<string, unknown>,
      nextRunAt: this.computeNextRun(def, cur.enabled),
      changeVia: actor.via,
      ...(actor.agentId ? { changedByAgentId: actor.agentId } : {}),
      changeNote: input.note ?? "",
      ...(input.expectVersion !== undefined ? { expectVersion: input.expectVersion } : {}),
    });
    if (!row) throw new WorkflowError("Quy trình vừa được người khác sửa (phiên bản đã đổi) — tải lại rồi sửa tiếp", 409);
    await recordAudit(this.db, actor.ctx, "workflow.update", { id, version: row.version, via: actor.via, ...(actor.agentId ? { agentId: actor.agentId } : {}) });
    const warnings = [...v.warnings, ...(await this.approvalWarnings(actor.ctx, def))];
    for (const sid of stripped) warnings.push({ path: sid, message: "Cờ approved bị bỏ — chỉ quản trị viên duyệt trên Dashboard" });
    return { row, warnings, diff };
  }

  async restore(actor: WorkflowActor, id: string, version: number) {
    const v = await getWorkflowVersion(this.db, actor.ctx, id, version);
    if (!v) throw new WorkflowError(`Không có phiên bản ${version}`, 404);
    return this.update({ ...actor, via: "restore" }, id, { definition: v.definition, note: `Hoàn về bản ${version}` });
  }

  async setEnabled(actor: WorkflowActor, id: string, enabled: boolean): Promise<WorkflowRow> {
    const cur = await this.mustGet(actor.ctx, id);
    if (enabled && !cur.enabled) {
      // Bật lên = kiểm chặt: tên kênh / agent / tool… phải có thật
      const v = await this.validate(actor.ctx, cur.definition);
      if (!v.ok) {
        throw new WorkflowError(`Chưa bật được — sửa các chỗ sau trước:\n${formatIssues(v.errors)}`, 400, v.errors, v.warnings);
      }
      await this.assertEnabledQuota(actor.ctx);
    }
    const row = await updateWorkflowMeta(this.db, actor.ctx, id, {
      enabled,
      nextRunAt: this.computeNextRun(cur.definition as unknown as WorkflowDefinition, enabled),
    });
    await recordAudit(this.db, actor.ctx, enabled ? "workflow.enable" : "workflow.disable", { id, via: actor.via });
    return row!;
  }

  async setOwner(actor: WorkflowActor, id: string, ownerUserId: string): Promise<WorkflowRow> {
    await this.mustGet(actor.ctx, id);
    const role = await getActiveMemberRole(this.db, actor.ctx, ownerUserId);
    if (!role || !hasRole(role, "operator")) throw new WorkflowError("Người sở hữu phải là operator trở lên trong workspace");
    const row = await updateWorkflowMeta(this.db, actor.ctx, id, { ownerUserId });
    await recordAudit(this.db, actor.ctx, "workflow.owner", { id, ownerUserId });
    return row!;
  }

  async remove(actor: WorkflowActor, id: string): Promise<void> {
    const cur = await this.mustGet(actor.ctx, id);
    this.running.forEach((ctrl, key) => {
      if (key.startsWith(`${id}:`)) ctrl.abort(new Error("Quy trình đã bị xóa"));
    });
    await deleteWorkflow(this.db, actor.ctx, id);
    await recordAudit(this.db, actor.ctx, "workflow.delete", { id, name: cur.name, via: actor.via });
  }

  async rotateWebhook(actor: WorkflowActor, id: string): Promise<WorkflowRow> {
    await this.mustGet(actor.ctx, id);
    const row = await updateWorkflowMeta(this.db, actor.ctx, id, {
      webhookTokenEncrypted: encryptSecret(randomBytes(24).toString("base64url")),
      webhookSecretEncrypted: encryptSecret(randomBytes(32).toString("hex")),
    });
    await recordAudit(this.db, actor.ctx, "workflow.webhook_rotate", { id });
    return row!;
  }

  async mustGet(ctx: WorkspaceContext, idOrSlug: string): Promise<WorkflowRow> {
    const ref = idOrSlug.trim();
    const row = /^[0-9a-f-]{36}$/i.test(ref) ? await getWorkflow(this.db, ctx, ref) : await getWorkflowBySlug(this.db, ctx, ref);
    if (!row) throw new WorkflowError(`Không có quy trình "${idOrSlug}"`, 404);
    return row;
  }

  webhookInfo(row: WorkflowRow): { url: string; secret: string; token: string } | null {
    const def = row.definition as unknown as WorkflowDefinition;
    if (!def.triggers?.some((t) => t.type === "webhook") || !row.webhookTokenEncrypted) return null;
    try {
      const token = decryptSecret(row.webhookTokenEncrypted);
      const secret = row.webhookSecretEncrypted ? decryptSecret(row.webhookSecretEncrypted) : "";
      return { url: `${this.publicBase}/webhooks/workflow/${row.id}/${token}`, secret, token };
    } catch {
      return null;
    }
  }

  // ======================= chạy =======================

  /** Bắt đầu một lần chạy (nền). Trả runId ngay + promise kết quả. */
  async start(ctx: WorkspaceContext, idOrRow: string | WorkflowRow, req: RunRequest): Promise<StartedRun | { skipped: string }> {
    if (!this.cfg.enabled) throw new WorkflowError("Tính năng Quy trình đang tắt (cấu hình workflows.enabled)", 503);
    const row = typeof idOrRow === "string" ? await this.mustGet(ctx, idOrRow) : idOrRow;
    if (!row.enabled && !req.allowDisabled) throw new WorkflowError(`Quy trình "${row.name}" đang tắt`, 409);
    if ((req.depth ?? 0) > 3) throw new WorkflowError("Gọi quy trình lồng nhau quá 3 cấp", 400);
    const def = row.definition as unknown as WorkflowDefinition;
    // Mặc định: lượt theo lịch trùng lượt trước thì bỏ; webhook/tay chạy song song
    // (nhiều bên gọi webhook độc lập — bỏ lượt là mất dữ liệu của họ).
    const conc = def.settings?.concurrency ?? (req.triggerType === "schedule" ? "skip" : "parallel");
    const busy = this.inFlight.get(row.id) ?? 0;
    if (busy > 0 && conc === "skip" && (req.triggerType === "schedule" || req.triggerType === "webhook")) {
      return { skipped: "Lần chạy trước của quy trình chưa xong (concurrency: skip)" };
    }

    // Người sở hữu: lần chạy mang quyền HIỆN TẠI của người này
    const sysCtx = systemContext(row.workspaceId);
    let runCtx: WorkspaceContext;
    let ownerRole: WorkspaceRole;
    if (row.ownerUserId) {
      const role = await getActiveMemberRole(this.db, sysCtx, row.ownerUserId);
      if (!role || !hasRole(role, "operator")) {
        throw new WorkflowError("Người sở hữu quy trình không còn trong workspace hoặc không còn quyền operator — đổi người sở hữu trên Dashboard", 409);
      }
      runCtx = { workspaceId: row.workspaceId, userId: row.ownerUserId, role };
      ownerRole = role;
    } else {
      runCtx = { workspaceId: row.workspaceId, userId: row.workspaceId, role: "operator" };
      ownerRole = "operator";
    }

    const run = await createWorkflowRun(this.db, runCtx, {
      workflowId: row.id,
      version: row.version,
      triggerType: req.triggerType,
      trigger: { type: req.triggerType, ...(req.trigger ?? {}) },
      inputs: req.inputs ?? {},
      isTest: req.test === true,
      dryRun: req.dryRun === true,
      ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
    });
    this.inFlight.set(row.id, busy + 1);
    const ctrl = new AbortController();
    const key = `${row.id}:${run.id}`;
    this.running.set(key, ctrl);

    const exec = async (): Promise<RunResult> => {
      const release = await this.sem.acquire();
      try {
        return await this.execute(row, run.id, runCtx, ownerRole, req, ctrl.signal);
      } finally {
        release();
      }
    };
    // concurrency: queue → nối đuôi lần chạy trước của cùng quy trình
    let done: Promise<RunResult>;
    if (conc === "queue") {
      const prev = this.queues.get(row.id) ?? Promise.resolve();
      done = prev.catch(() => undefined).then(exec);
      this.queues.set(row.id, done.catch(() => undefined));
    } else done = exec();
    done = done
      .catch(async (err): Promise<RunResult> => {
        const msg = (err as Error).message;
        await finishWorkflowRun(this.db, runCtx, run.id, { status: "failed", error: msg, output: null, response: null, stepCount: 0, durationMs: 0, updateWorkflow: !req.test }).catch(() => {});
        return { status: "failed", output: null, error: msg, response: null, stepCount: 0, durationMs: 0 };
      })
      .finally(() => {
        this.running.delete(key);
        const n = (this.inFlight.get(row.id) ?? 1) - 1;
        if (n <= 0) this.inFlight.delete(row.id);
        else this.inFlight.set(row.id, n);
      });
    return { runId: run.id, done };
  }

  cancel(runId: string): boolean {
    for (const [key, ctrl] of this.running) {
      if (key.endsWith(`:${runId}`)) {
        ctrl.abort(new Error("Đã hủy lần chạy"));
        return true;
      }
    }
    return false;
  }

  /** Chạy và chờ kết quả (có trần thời gian chờ — quá thì vẫn chạy tiếp ở nền). */
  async runAndWait(ctx: WorkspaceContext, id: string, req: RunRequest, waitMs = 120_000) {
    const started = await this.start(ctx, id, req);
    if ("skipped" in started) return { skipped: started.skipped };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)));
    const res = await Promise.race([started.done, timeout]);
    if (timer) clearTimeout(timer);
    return { runId: started.runId, result: res };
  }

  private async secretsFor(ctx: WorkspaceContext): Promise<Record<string, string>> {
    const rows = await listWorkspaceSecretValues(this.db, ctx).catch(() => []);
    const out: Record<string, string> = {};
    for (const r of rows) {
      try {
        out[r.name] = decryptSecret(r.valueEncrypted);
      } catch {
        logger.warn(`Quy trình: không giải mã được khóa bí mật ${r.name}`);
      }
    }
    return out;
  }

  private async execute(
    row: WorkflowRow,
    runId: string,
    ctx: WorkspaceContext,
    ownerRole: WorkspaceRole,
    req: RunRequest,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const def = row.definition as unknown as WorkflowDefinition;
    const secrets = await this.secretsFor(ctx);
    // Giá trị bí mật mới do bước secret lưu giữa chừng (token vừa làm mới): che trong
    // nhật ký chưa ghi + sửa nhật ký đã ghi khi lần chạy xong.
    const newSecretValues: string[] = [];
    let seq = 0;
    let buffer: Parameters<typeof addWorkflowRunSteps>[3] = [];
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => {
      if (!buffer.length) return flushing;
      const batch = newSecretValues.length ? (maskSecrets(buffer, newSecretValues) as typeof buffer) : buffer;
      buffer = [];
      flushing = flushing.then(() => addWorkflowRunSteps(this.db, ctx, runId, batch).catch((e) => logger.warn(`Quy trình: ghi nhật ký bước lỗi — ${(e as Error).message}`)));
      return flushing;
    };
    const onStep = (l: StepLog) => {
      buffer.push({ seq: seq++, ...l });
      if (buffer.length >= 25) void flush();
    };
    const host = this.makeHost(row, runId, ctx, ownerRole, req, Object.values(secrets));
    let result: RunResult;
    try {
    result = await runWorkflow({
      definition: def,
      host,
      inputs: req.inputs ?? {},
      trigger: { type: req.triggerType, ...(req.trigger ?? {}) },
      secrets,
      workflow: { id: row.id, name: row.name, runId, version: row.version },
      timezone: this.rt.config.timezone,
      maxRunMs: this.cfg.maxRunSeconds * 1000,
      stepTimeoutMs: this.cfg.stepTimeoutSeconds * 1000,
      dryRun: req.dryRun === true,
      allowShell: this.cfg.allowShell,
      signal,
      onStep,
      onSecretValue: (v) => {
        newSecretValues.push(v);
      },
      ...(req.onRespond ? { onRespond: req.onRespond } : {}),
    });
    await flush();
    if (newSecretValues.length) await scrubWorkflowRunSteps(this.db, ctx, runId, newSecretValues).catch((e) => logger.warn(`Quy trình: che khóa trong nhật ký lỗi — ${(e as Error).message}`));
    } finally {
      await releaseRunLocks(this.db, runId).catch(() => {});
    }
    await finishWorkflowRun(this.db, ctx, runId, {
      status: result.status,
      error: result.error,
      output: result.output,
      response: result.response,
      stepCount: result.stepCount,
      durationMs: result.durationMs,
      updateWorkflow: req.test !== true,
    });
    if ((result.status === "failed" || result.status === "timeout") && !req.test) {
      const n = def.settings?.notifyOnError;
      if (n) {
        await this.sendToChat(ctx, n.channel, n.to, `⚠️ Quy trình "${row.name}" lỗi lúc chạy (${req.triggerType}): ${String(result.error).slice(0, 500)}`, [], row).catch((e) =>
          logger.warn(`Quy trình "${row.name}": báo lỗi thất bại — ${(e as Error).message}`),
        );
      }
      logger.warn(`Quy trình "${row.name}" ${result.status}: ${result.error}`);
    }
    return result;
  }

  // ======================= host =======================

  private workflowDir(row: WorkflowRow): string {
    return resolve(join(this.rt.config.dataDir, row.workspaceId, "users", workflowUserKey(row.id)));
  }

  private resolveFile(row: WorkflowRow, p: string): string {
    const base = this.workflowDir(row);
    const wsDir = resolve(join(this.rt.config.dataDir, row.workspaceId));
    const abs = resolve(base, p.replace(/^\/+/, ""));
    if (abs !== base && !abs.startsWith(base + sep)) {
      // Cho phép đường dẫn tuyệt đối trong vùng dữ liệu của workspace (file agent vừa tạo…)
      const absIn = resolve(p);
      if (p.startsWith("/") && (absIn === wsDir || absIn.startsWith(wsDir + sep))) return absIn;
      throw new Error(`Đường dẫn "${p}" nằm ngoài thư mục của quy trình`);
    }
    return abs;
  }

  /** Tìm kênh theo id / "kind:tên" / tên. */
  private async resolveChannel(ctx: WorkspaceContext, ref: string) {
    const chans = await listChannels(this.db, ctx);
    const r = ref.trim().toLowerCase();
    const ch = chans.find((c) => c.id === ref || `${c.kind}:${c.name}`.toLowerCase() === r || c.name.toLowerCase() === r);
    if (!ch) throw new Error(`Kênh "${ref}" không tồn tại; kênh có: ${chans.map((c) => `${c.kind}:${c.name}`).join(", ") || "(chưa có)"}`);
    if (!ch.enabled) throw new Error(`Kênh "${ch.name}" đang tạm dừng`);
    const channel = channelHandlers.get(ch.id)?.channel;
    if (!channel || !channel.isRunning()) throw new Error(`Kênh "${ch.name}" chưa sẵn sàng gửi tin (chưa kết nối)`);
    return { row: ch, channel };
  }

  /** Gửi tin vào một cuộc trò chuyện + ghi vào hội thoại để người dùng trả lời tiếp thì agent biết. */
  private async sendToChat(ctx: WorkspaceContext, channelRef: string, to: string, text: string, media: string[], wf: WorkflowRow, label = "Quy trình") {
    const { row: ch, channel } = await this.resolveChannel(ctx, channelRef);
    await channel.send({ chatKey: to, text, ...(media.length ? { media } : {}) });
    const sid = await getChannelSession(this.db, ctx, ch.id, to).catch(() => null);
    if (sid && text) {
      await scheduleOnChannelQueue(sid, () =>
        appendMessage(this.db, ctx, sid, { role: "assistant", content: { kind: "assistant", text: `⚙️ [${label} "${wf.name}"]\n${text}`, toolCalls: [] } }),
      ).catch(() => {});
    }
    return { sent: true, channel: `${ch.kind}:${ch.name}`, to, ...(media.length ? { files: media.length } : {}) };
  }

  private parseToolResult(result: string): unknown {
    const files: string[] = [];
    const text = result.replace(MEDIA_RE, (_m, p: string) => {
      files.push(p);
      return "";
    }).trim();
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      // không phải JSON
    }
    if (parsed !== undefined && !files.length) return parsed;
    return { text, ...(parsed !== undefined ? { json: parsed } : {}), ...(files.length ? { files } : {}) };
  }

  private makeHost(row: WorkflowRow, runId: string, ctx: WorkspaceContext, ownerRole: WorkspaceRole, req: RunRequest, secretValues: string[]): WorkflowHost {
    const dir = this.workflowDir(row);
    const ensureDir = mkdir(dir, { recursive: true }).catch(() => {});
    const rt = this.rt;
    const userKey = workflowUserKey(row.id);
    const allowPrivate = this.cfg.allowPrivateNetwork;

    const toolCtxBase = (signal: AbortSignal, approved: boolean): ToolContext => ({
      ctx,
      workspaceDataDir: resolve(join(rt.config.dataDir, ctx.workspaceId)),
      workDir: dir,
      sharedDir: resolve(join(rt.config.dataDir, ctx.workspaceId, "shared")),
      userKey,
      execSandbox: execSandboxFor(rt.config.dataDir, ctx.workspaceId),
      timezone: rt.config.timezone,
      signal,
      requestApproval: async () => approved,
    });

    return {
      http: async (r) => {
        let url = r.url;
        let method = r.method;
        let body = r.body;
        for (let hop = 0; hop < 6; hop++) {
          if (!(await isUrlAllowed(url, allowPrivate))) {
            throw new Error(`Từ chối gọi "${new URL(url).host}": địa chỉ nội bộ hoặc không phân giải được (chỉ gọi địa chỉ công khai)`);
          }
          const res = await fetch(url, { method, headers: r.headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: r.signal });
          if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            url = new URL(res.headers.get("location")!, url).toString();
            if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
              method = "GET";
              body = undefined;
            }
            continue;
          }
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            if (k !== "set-cookie") headers[k] = v;
          });
          const reader = res.body?.getReader();
          const chunks: Buffer[] = [];
          let size = 0;
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > HTTP_MAX_BYTES) {
                await reader.cancel().catch(() => {});
                throw new Error(`Phản hồi quá lớn (> ${HTTP_MAX_BYTES / 1024 / 1024} MB)`);
              }
              chunks.push(Buffer.from(value));
            }
          }
          const buf = Buffer.concat(chunks);
          const ct = headers["content-type"] ?? "";
          let parsed: unknown;
          if (/json/i.test(ct) || /^\s*[[{]/.test(buf.subarray(0, 50).toString("utf8"))) {
            try {
              parsed = JSON.parse(buf.toString("utf8"));
            } catch {
              parsed = buf.toString("utf8");
            }
          } else if (/^(text\/|application\/(xml|javascript|x-www-form-urlencoded))/i.test(ct) || !ct) {
            parsed = buf.toString("utf8");
          } else {
            parsed = { base64: buf.toString("base64").slice(0, 200_000), contentType: ct, size: buf.length };
          }
          return { status: res.status, headers, body: parsed };
        }
        throw new Error("Chuyển hướng (redirect) quá 5 lần");
      },

      send: async (x) => {
        await ensureDir;
        const media = x.files.map((f) => this.resolveFile(row, f));
        return this.sendToChat(ctx, x.channel, x.to, x.text, media, row);
      },

      tool: async (x) => {
        await ensureDir;
        if (x.tool.startsWith("workflow_")) throw new Error("Không gọi tool workflow_* từ trong quy trình — dùng bước subworkflow");
        if (x.agent) {
          const agent = await getAgentByKey(this.db, ctx, x.agent);
          if (!agent) throw new Error(`Agent "${x.agent}" không tồn tại`);
          const deps = await buildLoopDeps(rt, ctx, agent.provider, {
            ...agentOpts(agent),
            agentId: agent.id,
            userKey,
            skipUserMcpLayer: true,
            sourceKind: "cron",
            accessRole: ownerRole,
            autoApproveExec: x.approved,
          });
          if (!deps.tools.has(x.tool)) throw new Error(`Agent "${x.agent}" không có (hoặc đã tắt) tool "${x.tool}"`);
          const res = await deps.tools.execute(x.tool, x.args, { ...(deps as unknown as ToolContext), ctx, signal: x.signal, requestApproval: async () => x.approved });
          if (res.isError) throw new Error(res.result);
          return this.parseToolResult(res.result);
        }
        const reg = await buildWorkspaceRegistry(rt, ctx);
        if (!reg.has(x.tool)) throw new Error(`Tool "${x.tool}" không có — xem danh mục tool (workflow_catalog)`);
        const res = await reg.execute(x.tool, x.args, toolCtxBase(x.signal, x.approved));
        if (res.isError) throw new Error(res.result);
        return this.parseToolResult(res.result);
      },

      mcp: async (x) => {
        await ensureDir;
        if (!rt.mcp) throw new Error("MCP chưa bật trên máy chủ này");
        const h = rt.mcp.findTool(ctx.workspaceId, x.server, x.tool);
        if (!h) {
          const cat = rt.mcp.catalogFor(ctx.workspaceId);
          const srv = cat.find((c) => c.serverName.toLowerCase() === x.server.toLowerCase() || c.serverId === x.server);
          throw new Error(
            srv
              ? `MCP "${srv.serverName}" không có tool "${x.tool}"; tool có: ${srv.tools.map((t) => t.name).join(", ")}`
              : `MCP server "${x.server}" không có hoặc chưa kết nối; server đang kết nối: ${cat.map((c) => c.serverName).join(", ") || "(không có)"}`,
          );
        }
        const out = await h.execute(x.args, toolCtxBase(x.signal, false));
        if (/^Từ chối: /.test(out)) throw new Error(out);
        return this.parseToolResult(out);
      },

      agent: async (x) => {
        await ensureDir;
        const agent = await getAgentByKey(this.db, ctx, x.agent);
        if (!agent) throw new Error(`Agent "${x.agent}" không tồn tại`);
        const session = await createSession(this.db, ctx, {
          agentId: agent.id,
          title: `⚙️ ${row.name}`,
          ...(ctx.userId !== ctx.workspaceId ? { ownerUserId: ctx.userId } : {}),
        });
        let collector: ReturnType<typeof createOutboundCollector> | null = null;
        const deps = await buildLoopDeps(rt, ctx, agent.provider, {
          ...agentOpts(agent),
          agentId: agent.id,
          userKey,
          skipUserMcpLayer: true,
          sourceKind: "cron",
          accessRole: ownerRole,
          gateBucket: `workflow:${row.id}`,
          ...(x.deliver ? { attachFile: (p: string) => collector?.attachFile(p) } : {}),
        });
        if (x.deliver) {
          collector = createOutboundCollector(deps.workDir ?? deps.workspaceDataDir, deps.sharedDir ?? deps.workspaceDataDir);
          await collector.begin();
        }
        const effort = reasoningEffortOf(agent);
        let message = x.message;
        if (x.json) message += "\n\n(Trả lời CHỈ bằng một khối JSON hợp lệ, không thêm chữ nào khác.)";
        if (x.deliver) {
          message =
            `[Quy trình "${row.name}" giao việc]\n${message}\n\n` +
            "Câu trả lời của bạn sẽ được gửi NGUYÊN VĂN vào cuộc trò chuyện của người nhận như một tin nhắn chủ động. Viết thẳng cho họ, không nhắc tên tool.";
        }
        let res;
        try {
          res = await runAgentText(deps, {
            ctx,
            agent: { systemPrompt: agent.systemPrompt, model: agent.model, maxIterations: agent.maxIterations, ...(effort ? { reasoningEffort: effort } : {}) },
            sessionId: session.id,
            userMessage: message,
            signal: x.signal,
          });
        } finally {
          // ghi trace kể cả khi lỗi để thống kê token đúng
        }
        recordTraceSafe(this.db, ctx, {
          agentId: agent.id,
          sessionId: session.id,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          iterations: res.iterations,
          durationMs: res.durationMs,
          source: "workflow",
          model: agent.model,
          provider: agent.provider,
          kind: "workflow",
        });
        const text = res.text.replace(MEDIA_RE, "").trim();
        const out: { text: string; json?: unknown; usage: unknown; delivered?: unknown; sessionId: string } = {
          text,
          usage: res.usage,
          sessionId: session.id,
        };
        if (x.json) {
          const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
          const raw = (m ? m[1]! : text).trim();
          try {
            out.json = JSON.parse(raw);
          } catch {
            const brace = raw.search(/[[{]/);
            try {
              out.json = brace >= 0 ? JSON.parse(raw.slice(brace)) : null;
            } catch {
              throw new Error(`Agent không trả JSON hợp lệ: ${text.slice(0, 200)}`);
            }
          }
        }
        if (x.deliver) {
          const media = collector ? await collector.finish() : [];
          if (x.dryRun) out.delivered = { dryRun: true, channel: x.deliver.channel, to: x.deliver.to };
          else if (text || media.length) out.delivered = await this.sendToChat(ctx, x.deliver.channel, x.deliver.to, text, media, row);
        }
        return out;
      },

      subworkflow: async (x) => {
        const child = await this.mustGet(ctx, x.workflow);
        if (child.id === row.id) throw new Error("Quy trình không gọi được chính nó");
        const depth = Number((req.trigger as { depth?: number } | undefined)?.depth ?? req.depth ?? 0) + 1;
        const started = await this.start(ctx, child, {
          inputs: x.inputs,
          triggerType: "subworkflow",
          trigger: { parent: row.id, parentRunId: runId, depth },
          parentRunId: runId,
          depth,
          dryRun: x.dryRun,
          test: req.test === true,
          allowDisabled: true,
        });
        if ("skipped" in started) throw new Error(started.skipped);
        if (!x.wait) return { runId: started.runId };
        const r = await started.done;
        if (r.status === "failed" || r.status === "timeout" || r.status === "cancelled") throw new Error(`Quy trình con "${child.name}" ${r.status}: ${r.error}`);
        return { runId: started.runId, status: r.status, output: r.output };
      },

      file: async (x) => {
        await ensureDir;
        if (x.action === "list") {
          const base = x.path ? this.resolveFile(row, x.path) : dir;
          const out: Array<{ path: string; size: number; modifiedAt: string }> = [];
          const walk = async (d: string) => {
            for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
              if (out.length >= 500) return;
              const abs = join(d, e.name);
              if (e.isDirectory()) await walk(abs);
              else {
                const st = await stat(abs);
                out.push({ path: relative(dir, abs).split(sep).join("/"), size: st.size, modifiedAt: st.mtime.toISOString() });
              }
            }
          };
          await walk(base);
          return { files: out };
        }
        const abs = this.resolveFile(row, x.path);
        if (x.action === "read") {
          const st = await stat(abs).catch(() => null);
          if (!st) throw new Error(`Không có file "${x.path}"`);
          if (st.size > HTTP_MAX_BYTES) throw new Error("File quá lớn (> 5 MB)");
          const content = await readFile(abs, "utf8");
          let json: unknown;
          if (/\.json$/i.test(abs)) {
            try {
              json = JSON.parse(content);
            } catch {
              // để nguyên text
            }
          }
          return { path: x.path, absPath: abs, content, ...(json !== undefined ? { json } : {}) };
        }
        if (x.action === "delete") {
          await rm(abs, { force: true });
          return { deleted: x.path };
        }
        await mkdir(dirname(abs), { recursive: true });
        if (x.action === "append") await appendFile(abs, x.content ?? "", "utf8");
        else await writeFile(abs, x.content ?? "", "utf8");
        const st = await stat(abs);
        return { path: x.path, absPath: abs, size: st.size };
      },

      db: async (x) => {
        const allow = allowForRole(ownerRole) ?? "read";
        return getWsdbService(rt).query(
          { ctx, allow, actor: { via: "workflow", workflowId: row.id, userId: ctx.userId } },
          { sql: x.sql, params: x.params, confirm: x.confirm, dryRun: x.dryRun },
        );
      },

      secret: async (x) => {
        const sleepMs = (ms: number) => new Promise<void>((r, j) => {
          const t = setTimeout(r, ms);
          x.signal.addEventListener("abort", () => { clearTimeout(t); j(x.signal.reason ?? new Error("Đã hủy")); }, { once: true });
        });
        try {
          switch (x.op) {
            case "set": {
              const meta = await workflowWriteSecret(this.db, ctx, {
                name: x.name,
                valueEncrypted: encryptSecret(x.value ?? ""),
                expiresAt: x.expiresAt ? new Date(x.expiresAt) : null,
                ...(x.note !== undefined ? { note: x.note } : {}),
                workflowId: row.id,
              });
              return { output: { saved: true, name: meta.name, version: meta.version, expiresAt: meta.expiresAt?.toISOString() ?? null } };
            }
            case "info": {
              const m = await getWorkspaceSecretMeta(this.db, ctx, x.name);
              if (!m) return { output: { name: x.name, exists: false, expired: true, expiresAt: null, expiresInSec: null } };
              const left = m.expiresAt ? Math.round((m.expiresAt.getTime() - Date.now()) / 1000) : null;
              return {
                output: {
                  name: m.name,
                  exists: true,
                  expiresAt: m.expiresAt?.toISOString() ?? null,
                  expiresInSec: left,
                  expired: left !== null && left <= 0,
                  version: m.version,
                  updatedAt: m.updatedAt.toISOString(),
                  updatedVia: m.updatedVia,
                  writable: m.workflowWritable,
                },
              };
            }
            case "delete":
              return { output: { name: x.name, deleted: await workflowDeleteSecret(this.db, ctx, x.name) } };
            case "lock": {
              const t0 = Date.now();
              const wait = Math.max(0, x.waitMs ?? 60_000);
              const ttl = Math.max(5_000, x.ttlMs ?? 120_000);
              for (;;) {
                if (await tryAcquireWorkflowLock(this.db, ctx, x.name, runId, ttl)) break;
                if (Date.now() - t0 >= wait) throw new Error(`Đang có lần chạy khác giữ khóa "${x.name}" quá ${Math.round(wait / 1000)}s — thử lại sau`);
                await sleepMs(1000);
              }
              // Lần chạy giữ khóa trước có thể vừa làm mới token → nạp lại giá trị mới nhất
              return { output: { locked: true, name: x.name, waitedMs: Date.now() - t0 }, secrets: await this.secretsFor(ctx) };
            }
            case "unlock":
              return { output: { name: x.name, released: await releaseWorkflowLock(this.db, ctx, x.name, runId) } };
          }
        } catch (err) {
          if (err instanceof SecretNotWritableError) throw new Error(err.message);
          throw err;
        }
        throw new Error(`Thao tác "${String(x.op)}" không có`);
      },

      shell: async (x) => {
        await ensureDir;
        const reg = createDefaultToolRegistry();
        const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
        const prefix = Object.entries(x.env)
          .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          .map(([k, v]) => `export ${k}=${q(v)};`)
          .join(" ");
        const res = await reg.execute("exec", { command: `${prefix ? prefix + " " : ""}${x.command}`, timeoutMs: Math.min(x.timeoutMs, 600_000) }, toolCtxBase(x.signal, true));
        let out = res.result;
        for (const s of secretValues) if (s.length >= 4) out = out.split(s).join("***");
        if (res.isError) throw new Error(out);
        return { output: out };
      },
    };
  }

  // ======================= bộ chạy theo lịch =======================

  async startScheduler(): Promise<void> {
    if (!this.cfg.enabled) return;
    try {
      const n = await failInterruptedWorkflowRuns(this.db);
      if (n) logger.warn(`Quy trình: ${n} lần chạy bị cắt ngang do máy chủ khởi động lại`);
      for (const w of await listWorkflowsNeedingSchedule(this.db)) {
        const ctx = systemContext(w.workspaceId);
        const row = await getWorkflow(this.db, ctx, w.id);
        if (row) await setWorkflowNextRun(this.db, ctx, row.id, this.computeNextRun(row.definition as unknown as WorkflowDefinition, row.enabled));
      }
    } catch (err) {
      logger.warn(`Quy trình: khởi động bộ chạy lịch lỗi — ${(err as Error).message}`);
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    const prune = () =>
      pruneWorkflowData(this.db, this.cfg.keepRuns)
        .then((n) => n && logger.info(`Quy trình: dọn ${n} lần chạy cũ`))
        .catch((e) => logger.warn(`Quy trình: dọn dẹp lỗi — ${(e as Error).message}`));
    setTimeout(() => void prune(), 60_000).unref?.();
    this.pruneTimer = setInterval(() => void prune(), 6 * 3_600_000);
    logger.info("Bộ chạy quy trình theo lịch đã khởi động");
  }

  async tick(now = new Date()): Promise<Array<Promise<unknown>>> {
    if (this.stopping) return [];
    let due: Awaited<ReturnType<typeof claimDueWorkflows>>;
    try {
      due = await claimDueWorkflows(this.db, now, 20);
    } catch (err) {
      logger.warn(`Quy trình: lỗi lấy lịch — ${(err as Error).message}`);
      return [];
    }
    const runs: Array<Promise<unknown>> = [];
    for (const d of due) {
      const ctx = systemContext(d.workspaceId);
      try {
        const row = await getWorkflow(this.db, ctx, d.id);
        if (!row) continue;
        const def = row.definition as unknown as WorkflowDefinition;
        await setWorkflowNextRun(this.db, ctx, row.id, this.computeNextRun(def, row.enabled, new Date(Math.max(now.getTime(), d.dueAt.getTime()) + 1000)));
        const started = await this.start(ctx, row, { triggerType: "schedule", trigger: { at: d.dueAt.toISOString() } });
        if ("skipped" in started) logger.info(`Quy trình "${row.name}": bỏ lượt theo lịch — ${started.skipped}`);
        else runs.push(started.done);
      } catch (err) {
        logger.warn(`Quy trình ${d.id}: chạy theo lịch lỗi — ${(err as Error).message}`);
      }
    }
    return runs;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const ctrl of this.running.values()) ctrl.abort(new Error("Máy chủ đang tắt"));
  }

  get runningCount(): number {
    return this.sem.running;
  }

  // ======================= hiển thị =======================

  /** Mô tả gọn cho AI/người đọc. */
  describeRow(row: WorkflowRow): Record<string, unknown> {
    const def = row.definition as unknown as WorkflowDefinition;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      version: row.version,
      triggers: (def.triggers ?? []).map((t) => (t.type === "schedule" ? `schedule ${scheduleOf(t)}` : t.type)),
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastRunStatus: row.lastRunStatus,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      dashboardUrl: `${this.publicBase}/#/workflows/${row.id}`,
    };
  }

  async getRun(ctx: WorkspaceContext, runId: string) {
    return getWorkflowRun(this.db, ctx, runId);
  }
}

const services = new WeakMap<object, WorkflowService>();

/** Một WorkflowService cho mỗi database (dùng chung giữa API, agent, MCP server, bộ chạy lịch). */
export function getWorkflowService(rt: RuntimeDeps): WorkflowService {
  let svc = services.get(rt.db);
  if (!svc) {
    svc = new WorkflowService(rt);
    services.set(rt.db, svc);
  }
  return svc;
}

/** Khóa ổn định để so (vd token webhook). */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
