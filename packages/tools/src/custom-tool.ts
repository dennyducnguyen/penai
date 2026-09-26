import { exec } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RawToolHandler } from "./registry.js";
import { scrubSecretEnv } from "./exec-sandbox.js";

const execAsync = promisify(exec);
const MAX_OUTPUT = 32 * 1024;
// Luôn dùng POSIX shell (bash) để quoting nhất quán với production Linux.
const SHELL = process.platform === "win32" ? "bash" : "/bin/sh";

export interface CustomToolDef {
  name: string;
  description: string;
  commandTemplate: string;
  paramsSchema: Record<string, unknown>;
  env?: Record<string, string>;
  requiresApproval: boolean;
}

/** Escape 1 giá trị để nhúng an toàn vào lệnh shell (bọc nháy đơn). */
function shellQuote(v: unknown): string {
  const s = String(v);
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Dựng 1 tool động từ định nghĩa custom (shell command template).
 * Template dùng {{param}} — thay bằng giá trị args đã shell-escape.
 * requiresApproval=true → cần requestApproval() đồng ý.
 */
export function buildCustomTool(def: CustomToolDef): RawToolHandler {
  return {
    name: def.name,
    description: def.description,
    parameters:
      Object.keys(def.paramsSchema).length > 0
        ? def.paramsSchema
        : { type: "object", properties: {} },
    async execute(args, toolCtx) {
      const cmd = def.commandTemplate.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
        if (!(key in args)) throw new Error(`Thiếu tham số {{${key}}}`);
        return shellQuote(args[key]);
      });

      if (def.requiresApproval) {
        const ok = toolCtx.requestApproval
          ? await toolCtx.requestApproval({ tool: def.name, summary: cmd.slice(0, 100) })
          : false;
        if (!ok) throw new Error("Chưa được phê duyệt");
      }

      const cwd = resolve(toolCtx.workspaceDataDir);
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd,
          timeout: 30_000,
          maxBuffer: MAX_OUTPUT * 2,
          windowsHide: true,
          shell: SHELL,
          // Bỏ bí mật của server (PENAI_MASTER_KEY, DATABASE_URL...) — tool cần
          // khóa nào thì khai trong env riêng của tool (mã hóa trong DB).
          env: { ...scrubSecretEnv(process.env), ...(def.env ?? {}) },
        });
        return (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, MAX_OUTPUT).trim() ||
          "(không có output)";
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        return `Lỗi: ${[e.stdout, e.stderr, e.message].filter(Boolean).join("\n").slice(0, MAX_OUTPUT)}`;
      }
    },
  };
}
