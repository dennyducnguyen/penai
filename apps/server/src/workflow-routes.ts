/**
 * API quy trình (/v1/workflows/*), khóa bí mật (/v1/secrets) và webhook công khai
 * (/webhooks/workflow/:id/:token). Xác thực: phiên Dashboard hoặc khóa API psk_
 * (Claude Code / phần mềm khác tạo quy trình từ xa). Xem docs/quy-trinh.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { decryptSecret, encryptSecret, hasRole, logger, type WorkspaceContext, type WorkspaceRole } from "@penai/shared";
import {
  consumeWorkflowNonce,
  deleteWorkspaceSecret,
  getWorkflowRun,
  getWorkflowVersion,
  lastRunStepOutputs,
  listWorkspaceUsers,
  listWorkflowRuns,
  listWorkflowRunSteps,
  listWorkflows,
  listWorkflowVersions,
  listWorkspaceSecrets,
  lookupWorkflowWebhook,
  recordAudit,
  upsertWorkspaceSecret,
  workflowRunStats,
  type Db,
  type WorkflowRow,
} from "@penai/db";
import { formatIssues, WORKFLOW_TEMPLATES, type WorkflowDefinition, type WorkflowOp } from "@penai/core";
import { systemContext } from "./agent-runtime.js";
import { WorkflowError, type WorkflowActor, type WorkflowService } from "./workflow-service.js";

const RunBody = z.object({
  inputs: z.record(z.string(), z.unknown()).optional(),
  wait: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  /** Chạy thử bản nháp chưa lưu (chỉ /test). */
  definition: z.unknown().optional(),
  waitSeconds: z.number().int().min(1).max(600).optional(),
});

const SecretBody = z.object({
  name: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Tên khóa viết HOA, số, dấu _ (vd MISA_API_KEY)"),
  value: z.string().min(1).max(20_000).optional(),
  note: z.string().max(500).optional(),
  /** Quy trình được ghi đè / xóa khóa này (bước secret). */
  workflowWritable: z.boolean().optional(),
  /** Hạn dùng (ISO) — null = bỏ hạn. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

function viaOf(req: FastifyRequest): WorkflowActor["via"] {
  return req.authInfo?.kind === "apikey" ? "api" : "dashboard";
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof WorkflowError) {
    return reply.code(err.status).send({
      error: err.message,
      ...(err.issues.length ? { issues: err.issues } : {}),
      ...(err.warnings.length ? { warnings: err.warnings } : {}),
    });
  }
  throw err;
}

/** Bản đầy đủ của một quy trình cho Dashboard/API. */
function present(svc: WorkflowService, row: WorkflowRow, role: WorkspaceRole, stats?: { total: number; failed: number; avgMs: number }) {
  const wh = hasRole(role, "operator") ? svc.webhookInfo(row) : null;
  return {
    ...svc.describeRow(row),
    ownerUserId: row.ownerUserId,
    createdVia: row.createdVia,
    lastChangeVia: row.lastChangeVia,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    definition: row.definition,
    ...(wh ? { webhook: { url: wh.url, hmacSecret: wh.secret } } : {}),
    ...(stats ? { stats } : {}),
  };
}

const rateWindows = new Map<string, number[]>();
function rateLimited(key: string, perMinute: number): boolean {
  const now = Date.now();
  const arr = (rateWindows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= perMinute) {
    rateWindows.set(key, arr);
    return true;
  }
  arr.push(now);
  rateWindows.set(key, arr);
  if (rateWindows.size > 5000) rateWindows.clear();
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Body thô → object (JSON / form / text). */
function parseBody(raw: string, contentType: string): unknown {
  if (!raw) return {};
  if (/json/i.test(contentType) || /^\s*[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new WorkflowError("Body JSON không hợp lệ", 400);
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType)) return Object.fromEntries(new URLSearchParams(raw));
  return { text: raw };
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: { svc: WorkflowService; db: Db }): void {
  const { svc, db } = deps;

  const need = (req: FastifyRequest, reply: FastifyReply, min: WorkspaceRole): boolean => {
    if (!hasRole(req.authCtx.role, min)) {
      void reply.code(403).send({ error: `Cần quyền ${min} trở lên` });
      return false;
    }
    return true;
  };
  const actor = (req: FastifyRequest): WorkflowActor => ({ ctx: req.authCtx, via: viaOf(req) });
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

  // ---------------- danh sách + tạo ----------------
  app.get("/v1/workflows", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    const rows = await listWorkflows(db, req.authCtx);
    const stats = new Map((await workflowRunStats(db, req.authCtx, 7).catch(() => [])).map((s) => [s.workflowId, s]));
    return {
      workflows: rows.map((r) => {
        const p = present(svc, r, req.authCtx.role, stats.get(r.id) ?? { total: 0, failed: 0, avgMs: 0 });
        delete (p as { definition?: unknown }).definition;
        const def = r.definition as unknown as WorkflowDefinition;
        return { ...p, stepCount: JSON.stringify(def.steps ?? []).split('"id"').length - 1 };
      }),
      running: svc.runningCount,
      enabled: svc.cfg.enabled,
    };
  });

  app.get("/v1/workflows/templates", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    return { templates: WORKFLOW_TEMPLATES };
  });

  app.get("/v1/workflows/catalog", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    const kind = (req.query as { kind?: string }).kind;
    return svc.catalog(req.authCtx, kind);
  });

  const validateHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!need(req, reply, "operator")) return;
    const body = (req.body ?? {}) as { definition?: unknown };
    const def = body.definition ?? req.body;
    const v = await svc.validate(req.authCtx, def);
    return { ok: v.ok, errors: v.errors, warnings: v.warnings, definition: v.definition, ...(v.ok ? {} : { message: formatIssues(v.errors) }) };
  };
  app.post("/v1/workflows/validate", validateHandler);

  app.post("/v1/workflows", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    const body = (req.body ?? {}) as { definition?: unknown; template?: string; enabled?: boolean; slug?: string; note?: string };
    let def = body.definition;
    let via = viaOf(req);
    if (body.template) {
      const t = WORKFLOW_TEMPLATES.find((x) => x.key === body.template);
      if (!t) return reply.code(404).send({ error: `Không có mẫu "${body.template}"` });
      def = JSON.parse(JSON.stringify(t.definition));
      via = "template";
    }
    if (def === undefined) def = req.body; // gửi thẳng định nghĩa
    try {
      const { row, warnings } = await svc.create(
        { ...actor(req), via },
        def,
        // Mẫu tạo ra ở trạng thái tắt — tên kênh/agent trong mẫu là giả định
        { enabled: body.template ? false : (body.enabled ?? true), ...(body.slug ? { slug: body.slug } : {}), ...(body.note ? { note: body.note } : {}) },
      );
      return reply.code(201).send({ workflow: present(svc, row, req.authCtx.role), warnings });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------------- một quy trình ----------------
  app.get("/v1/workflows/:id", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    try {
      const row = await svc.mustGet(req.authCtx, idOf(req));
      const last = await lastRunStepOutputs(db, req.authCtx, row.id).catch(() => null);
      const lastSteps: Record<string, { status: string; output: unknown; error: string | null; durationMs: number }> = {};
      for (const s of last?.steps ?? []) lastSteps[s.stepId] = { status: s.status, output: s.output, error: s.error, durationMs: s.durationMs };
      return { workflow: present(svc, row, req.authCtx.role), lastRun: last ? { runId: last.runId, steps: lastSteps } : null };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/workflows/:id/export", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    try {
      const row = await svc.mustGet(req.authCtx, idOf(req));
      reply.header("content-disposition", `attachment; filename="${row.slug}.workflow.json"`);
      return reply.type("application/json").send(JSON.stringify(row.definition, null, 2));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/v1/workflows/:id", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    const body = (req.body ?? {}) as { definition?: unknown; note?: string; expectVersion?: number };
    try {
      const { row, warnings, diff } = await svc.update(actor(req), idOf(req), {
        definition: body.definition ?? req.body,
        ...(body.note ? { note: body.note } : {}),
        ...(typeof body.expectVersion === "number" ? { expectVersion: body.expectVersion } : {}),
      });
      return { workflow: present(svc, row, req.authCtx.role), warnings, diff };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch("/v1/workflows/:id", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    const body = (req.body ?? {}) as { enabled?: boolean; ownerUserId?: string; ops?: WorkflowOp[]; note?: string; expectVersion?: number };
    try {
      const id = idOf(req);
      let row: WorkflowRow | null = null;
      let warnings: unknown[] = [];
      let diff: unknown[] = [];
      if (Array.isArray(body.ops) && body.ops.length) {
        const r = await svc.update(actor(req), id, {
          ops: body.ops,
          ...(body.note ? { note: body.note } : {}),
          ...(typeof body.expectVersion === "number" ? { expectVersion: body.expectVersion } : {}),
        });
        row = r.row;
        warnings = r.warnings;
        diff = r.diff;
      }
      if (typeof body.ownerUserId === "string") {
        if (!need(req, reply, "ws_admin")) return;
        row = await svc.setOwner(actor(req), id, body.ownerUserId);
      }
      if (typeof body.enabled === "boolean") row = await svc.setEnabled(actor(req), id, body.enabled);
      if (!row) return reply.code(400).send({ error: "Không có gì để sửa — gửi enabled, ownerUserId hoặc ops" });
      return { workflow: present(svc, row, req.authCtx.role), warnings, diff };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/v1/workflows/:id", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    try {
      await svc.remove(actor(req), idOf(req));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------------- chạy ----------------
  const runHandler = (test: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!need(req, reply, "operator")) return;
    const parsed = RunBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    const b = parsed.data;
    try {
      let row = await svc.mustGet(req.authCtx, idOf(req));
      if (test && b.definition !== undefined) {
        // Chạy thử bản nháp chưa lưu trên trang dựng
        const v = await svc.validate(req.authCtx, b.definition);
        if (!v.ok) throw new WorkflowError(`Bản nháp chưa hợp lệ:\n${formatIssues(v.errors)}`, 400, v.errors, v.warnings);
        row = { ...row, definition: v.definition as unknown as Record<string, unknown>, name: v.definition.name };
      }
      const label = req.authInfo?.kind === "apikey" ? "khóa API" : "Dashboard";
      const started = await svc.start(req.authCtx, row, {
        inputs: b.inputs ?? {},
        triggerType: test ? "test" : req.authInfo?.kind === "apikey" ? "api" : "manual",
        trigger: { by: req.authCtx.userId, via: label },
        test,
        dryRun: b.dryRun === true,
        allowDisabled: true,
      });
      if ("skipped" in started) return reply.code(409).send({ error: started.skipped });
      await recordAudit(db, req.authCtx, "workflow.run", { id: row.id, runId: started.runId, test, dryRun: b.dryRun === true });
      const wait = b.wait ?? test;
      if (!wait) return reply.code(202).send({ runId: started.runId });
      const waitMs = (b.waitSeconds ?? 120) * 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const res = await Promise.race([started.done, new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)))]);
      if (timer) clearTimeout(timer);
      const run = await getWorkflowRun(db, req.authCtx, started.runId);
      const steps = await listWorkflowRunSteps(db, req.authCtx, started.runId);
      return { runId: started.runId, finished: res !== null, run, steps };
    } catch (err) {
      return sendError(reply, err);
    }
  };
  app.post("/v1/workflows/:id/run", runHandler(false));
  app.post("/v1/workflows/:id/test", runHandler(true));

  app.get("/v1/workflows/:id/runs", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    const q = req.query as { status?: string; limit?: string; tests?: string };
    try {
      const row = await svc.mustGet(req.authCtx, idOf(req));
      const runs = await listWorkflowRuns(db, req.authCtx, row.id, {
        limit: Number(q.limit ?? 50),
        ...(q.status ? { status: q.status } : {}),
        includeTests: q.tests !== "0",
      });
      return { runs };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/workflows/:id/runs/:runId", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    const { runId } = req.params as { runId: string };
    const run = await getWorkflowRun(db, req.authCtx, runId);
    if (!run || (run.workflowId !== idOf(req) && !(await svc.mustGet(req.authCtx, idOf(req)).then((w) => w.id === run.workflowId).catch(() => false)))) {
      return reply.code(404).send({ error: "Không có lần chạy này" });
    }
    return { run, steps: await listWorkflowRunSteps(db, req.authCtx, runId) };
  });

  app.post("/v1/workflows/:id/runs/:runId/cancel", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    const { runId } = req.params as { runId: string };
    return { cancelled: svc.cancel(runId) };
  });

  // ---------------- phiên bản ----------------
  app.get("/v1/workflows/:id/versions", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    try {
      const row = await svc.mustGet(req.authCtx, idOf(req));
      const versions = await listWorkflowVersions(db, req.authCtx, row.id);
      return { versions: versions.map((v) => ({ ...v, definition: undefined })) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/workflows/:id/versions/:version", async (req, reply) => {
    if (!need(req, reply, "viewer")) return;
    try {
      const row = await svc.mustGet(req.authCtx, idOf(req));
      const v = await getWorkflowVersion(db, req.authCtx, row.id, Number((req.params as { version: string }).version));
      if (!v) return reply.code(404).send({ error: "Không có phiên bản này" });
      return { version: v };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/workflows/:id/versions/:version/restore", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    try {
      const { row, warnings, diff } = await svc.restore(actor(req), idOf(req), Number((req.params as { version: string }).version));
      return { workflow: present(svc, row, req.authCtx.role), warnings, diff };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/workflows/:id/webhook/rotate", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    try {
      const row = await svc.rotateWebhook(actor(req), idOf(req));
      return { workflow: present(svc, row, req.authCtx.role) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Người có thể làm chủ quy trình (operator trở lên) — ô chọn người sở hữu
  app.get("/v1/workflows-owners", async (req, reply) => {
    if (!need(req, reply, "ws_admin")) return;
    const users = await listWorkspaceUsers(db, req.authCtx).catch(() => []);
    return {
      users: (users as Array<{ id: string; email: string; name?: string | null; role: WorkspaceRole }>)
        .filter((u) => hasRole(u.role, "operator"))
        .map((u) => ({ id: u.id, email: u.email, name: u.name ?? "" })),
    };
  });

  // ---------------- khóa bí mật ----------------
  app.get("/v1/secrets", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    return { secrets: await listWorkspaceSecrets(db, req.authCtx) };
  });

  app.post("/v1/secrets", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    const p = SecretBody.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: p.error.issues.map((i) => i.message).join("; ") });
    try {
      const s = await upsertWorkspaceSecret(db, req.authCtx, {
        name: p.data.name,
        ...(p.data.value !== undefined ? { valueEncrypted: encryptSecret(p.data.value) } : {}),
        ...(p.data.note !== undefined ? { note: p.data.note } : {}),
        ...(p.data.workflowWritable !== undefined ? { workflowWritable: p.data.workflowWritable } : {}),
        ...(p.data.expiresAt !== undefined ? { expiresAt: p.data.expiresAt ? new Date(p.data.expiresAt) : null } : {}),
        via: viaOf(req),
      });
      await recordAudit(db, req.authCtx, "secret.upsert", { name: s.name });
      return { secret: s };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete("/v1/secrets/:name", async (req, reply) => {
    if (!need(req, reply, "operator")) return;
    const name = (req.params as { name: string }).name;
    const ok = await deleteWorkspaceSecret(db, req.authCtx, name);
    if (ok) await recordAudit(db, req.authCtx, "secret.delete", { name });
    return ok ? { ok: true } : reply.code(404).send({ error: "Không có khóa này" });
  });

  // ---------------- webhook công khai ----------------
  // Phạm vi riêng: body nhận dạng chuỗi thô (để kiểm chữ ký HMAC đúng từng byte).
  void app.register(async (scoped) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser("*", { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    const resolveHook = async (req: FastifyRequest, reply: FastifyReply) => {
      const { id, token } = req.params as { id: string; token: string };
      const wh = await lookupWorkflowWebhook(db, id).catch(() => null);
      const def = wh?.definition as unknown as WorkflowDefinition | undefined;
      const trig = def?.triggers?.find((t) => t.type === "webhook") as Extract<WorkflowDefinition["triggers"][number], { type: "webhook" }> | undefined;
      let ok = false;
      if (wh?.webhookTokenEncrypted) {
        try {
          ok = safeEqual(decryptSecret(wh.webhookTokenEncrypted), token);
        } catch {
          ok = false;
        }
      }
      if (!wh || !ok || !trig) {
        void reply.code(404).send({ error: "Webhook không tồn tại" });
        return null;
      }
      return { wh, trig, ctx: systemContext(wh.workspaceId) as WorkspaceContext };
    };

    const hook = async (req: FastifyRequest, reply: FastifyReply) => {
      const r = await resolveHook(req, reply);
      if (!r) return;
      const { wh, trig, ctx } = r;
      if (!wh.enabled) return reply.code(409).send({ error: "Quy trình đang tắt" });
      const methods = trig.methods?.length ? trig.methods : ["GET", "POST"];
      if (!methods.includes(req.method as "GET" | "POST")) return reply.code(405).send({ error: `Webhook chỉ nhận ${methods.join(", ")}` });
      if (rateLimited(wh.id, trig.rateLimit ?? svc.cfg.webhookRatePerMinute)) {
        return reply.code(429).header("retry-after", "60").send({ error: "Gọi quá nhiều lần mỗi phút — thử lại sau" });
      }
      const raw = typeof req.body === "string" ? req.body : "";
      if (trig.auth === "hmac") {
        const sig = String(req.headers["x-penai-signature"] ?? "");
        const ts = String(req.headers["x-penai-timestamp"] ?? "");
        const nonce = String(req.headers["x-penai-nonce"] ?? "");
        if (!sig || !ts || !nonce) return reply.code(401).send({ error: "Thiếu header ký x-penai-signature / x-penai-timestamp / x-penai-nonce" });
        if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 300_000) return reply.code(401).send({ error: "timestamp quá hạn (±5 phút, tính bằng mili giây)" });
        let secret = "";
        try {
          secret = wh.webhookSecretEncrypted ? decryptSecret(wh.webhookSecretEncrypted) : "";
        } catch {
          secret = "";
        }
        const expected = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
        if (!secret || !safeEqual(sig.replace(/^sha256=/, ""), expected)) return reply.code(401).send({ error: "Chữ ký sai" });
        if (!(await consumeWorkflowNonce(db, ctx, wh.id, nonce.slice(0, 200)))) return reply.code(409).send({ error: "nonce đã dùng (gửi lại)" });
      }
      let body: unknown;
      try {
        body = parseBody(raw, String(req.headers["content-type"] ?? ""));
      } catch (err) {
        return sendError(reply, err);
      }
      const query = { ...((req.query ?? {}) as Record<string, unknown>) };
      const inputs = { ...query, ...(body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}) };
      const headers: Record<string, string> = {};
      for (const h of ["content-type", "user-agent", "x-request-id", "x-forwarded-for"]) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v.slice(0, 300);
      }
      const respond = trig.respond ?? "async";
      let resolveRespond!: (r: { status: number; headers: Record<string, string>; body: unknown }) => void;
      const responded = new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((res) => (resolveRespond = res));
      let started;
      try {
        started = await svc.start(ctx, wh.id, {
          inputs,
          triggerType: "webhook",
          trigger: { method: req.method, query, body, headers },
          ...(respond === "wait" ? { onRespond: (x) => resolveRespond(x) } : {}),
        });
      } catch (err) {
        return sendError(reply, err);
      }
      if ("skipped" in started) return reply.code(409).send({ error: started.skipped });
      const statusUrl = `${svc.publicBase}/webhooks/workflow/${wh.id}/${(req.params as { token: string }).token}/runs/${started.runId}`;
      if (respond === "async") return reply.code(202).send({ runId: started.runId, statusUrl });

      const timeoutMs = (trig.timeoutSec ?? 30) * 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const winner = await Promise.race([
        responded.then((x) => ({ kind: "respond" as const, x })),
        started.done.then((x) => ({ kind: "done" as const, x })),
        new Promise<{ kind: "timeout" }>((r) => (timer = setTimeout(() => r({ kind: "timeout" }), timeoutMs))),
      ]);
      if (timer) clearTimeout(timer);
      // Trang HTML do quy trình trả về chạy cùng tên miền với Dashboard → cách ly
      reply.header("content-security-policy", "sandbox; default-src 'none'").header("x-content-type-options", "nosniff");
      if (winner.kind === "timeout") {
        return reply.code(504).send({ error: `Quy trình chưa xong sau ${timeoutMs / 1000}s — vẫn đang chạy ở nền`, runId: started.runId, statusUrl });
      }
      if (winner.kind === "respond") {
        const { status, headers: h, body: b } = winner.x;
        for (const [k, v] of Object.entries(h)) {
          if (!/^(set-cookie|content-security-policy|content-length|transfer-encoding|connection)$/i.test(k)) reply.header(k, v);
        }
        if (typeof b === "string") return reply.code(status).type(String(h["content-type"] ?? h["Content-Type"] ?? "text/plain; charset=utf-8")).send(b);
        return reply.code(status).send(b ?? null);
      }
      const res = winner.x;
      if (res.status === "success" || res.status === "stopped") return reply.code(200).send(res.output ?? { ok: true });
      return reply.code(500).send({ error: res.error, status: res.status, runId: started.runId });
    };

    scoped.get("/webhooks/workflow/:id/:token", hook);
    scoped.post("/webhooks/workflow/:id/:token", hook);

    scoped.get("/webhooks/workflow/:id/:token/runs/:runId", async (req, reply) => {
      const r = await resolveHook(req, reply);
      if (!r) return;
      const run = await getWorkflowRun(db, r.ctx, (req.params as { runId: string }).runId).catch(() => null);
      if (!run || run.workflowId !== r.wh.id) return reply.code(404).send({ error: "Không có lần chạy này" });
      return {
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        ...(run.response ? { response: run.response } : {}),
        output: run.output,
        error: run.error,
      };
    });
  });

  logger.debug?.("Đã đăng ký route quy trình");
}
