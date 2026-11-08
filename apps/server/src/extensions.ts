/**
 * Điểm gắn mở rộng (extension) — cho bản fork (vd bản nội bộ của một công ty) thêm
 * tính năng riêng mà KHÔNG sửa file lõi, nhờ vậy gộp phiên bản mới của PenAI gần như
 * không bao giờ xung đột.
 *
 * Cách dùng trong bản fork: tạo file `apps/server/src/extensions/<tên>.ts` (bản chính
 * thức để trống thư mục này), `export default` một PenaiExtension:
 *
 *   import type { PenaiExtension } from "../extensions.js";
 *   const ext: PenaiExtension = {
 *     name: "bao-cao-noi-bo",
 *     routes(app, deps) { app.get("/v1/ext/bao-cao", async (req) => ({ ok: true })); },
 *     tools: [myTool],                    // tool cho agent (ToolHandler của @penai/tools)
 *     uiScript: "PenaiUI.addPage('bao-cao', '📑', 'Báo cáo nội bộ', function () { … });",
 *     async start(deps) { … },            // việc chạy nền sau khi máy chủ lên
 *   };
 *   export default ext;
 *
 * Migration riêng: đặt trong packages/db/migrations/ với số 9001_<tên>.sql trở lên
 * (không trùng chuỗi 00xx của bản chính thức). Xem docs/mo-rong.md.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { logger } from "@penai/shared";
import { registerExtraTool, type ToolHandler } from "@penai/tools";
import type { RuntimeDeps } from "./agent-runtime.js";

export interface PenaiExtension {
  /** Tên ngắn (hiện trong nhật ký). */
  name: string;
  /** Đăng ký route Fastify (sau mọi route lõi; xác thực phiên/khóa API đã chạy sẵn — req.authCtx). */
  routes?: (app: FastifyInstance, deps: RuntimeDeps) => void;
  /** Tool thêm cho agent (có trong mọi agent, tắt từng agent ở Agents → Sửa như tool thường). */
  tools?: ToolHandler<never>[];
  /**
   * JavaScript chạy trong Dashboard sau mã lõi. Dùng window.PenaiUI:
   * addPage(id, icon, label, render, { admin, group }), api, el, esc, page, card, table, toast, state.
   */
  uiScript?: string;
  /** Chạy một lần sau khi máy chủ khởi động (lịch nền, kết nối ngoài…). */
  start?: (deps: RuntimeDeps) => void | Promise<void>;
}

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "extensions");
let loaded: PenaiExtension[] | null = null;

/** Nạp mọi extension trong apps/server/src/extensions/*.ts (một lần). Lỗi một extension không làm hỏng máy chủ. */
export async function loadExtensions(dir = EXT_DIR): Promise<PenaiExtension[]> {
  if (loaded && dir === EXT_DIR) return loaded;
  const out: PenaiExtension[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("_")).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    try {
      const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default?: PenaiExtension };
      const ext = mod.default;
      if (!ext || typeof ext.name !== "string") {
        logger.warn(`Extension ${f}: thiếu export default { name, … } — bỏ qua`);
        continue;
      }
      for (const t of ext.tools ?? []) registerExtraTool(t as ToolHandler<never>);
      out.push(ext);
      logger.info(`Đã nạp extension "${ext.name}" (${f})`);
    } catch (err) {
      logger.error(`Extension ${f} lỗi khi nạp — bỏ qua: ${(err as Error).message}`);
    }
  }
  if (dir === EXT_DIR) loaded = out;
  return out;
}

/** Extension đã nạp (rỗng nếu chưa gọi loadExtensions). */
export function loadedExtensions(): PenaiExtension[] {
  return loaded ?? [];
}

/** Gắn route của mọi extension. */
export function registerExtensionRoutes(app: FastifyInstance, deps: RuntimeDeps, exts = loadedExtensions()): void {
  for (const e of exts) {
    try {
      e.routes?.(app, deps);
    } catch (err) {
      logger.error(`Extension "${e.name}": đăng ký route lỗi — ${(err as Error).message}`);
    }
  }
}

/** Gộp uiScript của các extension thành một khối <script> chèn cuối Dashboard. */
export function extensionUiHtml(exts = loadedExtensions()): string {
  const parts = exts.filter((e) => e.uiScript).map((e) => `try{${e.uiScript}}catch(e){console.error("extension ${e.name.replace(/[^\w -]/g, "")}",e)}`);
  if (!parts.length) return "";
  return `<script>${parts.join("\n").replace(/<\/script/gi, "<\\/script")}</script>`;
}

export async function startExtensions(deps: RuntimeDeps, exts = loadedExtensions()): Promise<void> {
  for (const e of exts) {
    try {
      await e.start?.(deps);
    } catch (err) {
      logger.error(`Extension "${e.name}": khởi động lỗi — ${(err as Error).message}`);
    }
  }
}
