import { z } from "zod";
import type { WorkspaceContext } from "@penai/shared";
import type { ExecSandboxOptions } from "./exec-sandbox.js";

/** Ngữ cảnh runtime khi tool chạy. */
export interface ToolContext {
  ctx: WorkspaceContext;
  /** Thư mục dữ liệu của workspace — gốc chứa shared/ và users/. */
  workspaceDataDir: string;
  /**
   * Thư mục làm việc của lượt chạy này — RIÊNG từng người dùng kênh.
   * Không có (chat HTTP/cron) → dùng workspaceDataDir.
   */
  workDir?: string;
  /** Thư mục dùng chung của agent (mọi người dùng đọc được). */
  sharedDir?: string;
  /** Cho phép ghi vào vùng dùng chung (mặc định chỉ đọc). */
  canWriteShared?: boolean;
  /**
   * Thư viện file riêng của agent đang chạy (tiền tố "thu-vien/"). Quản trị viên
   * quản lý qua Dashboard → Thư viện file. Không có = lượt chạy không gắn agent.
   */
  libraryDir?: string;
  /** Agent được ghi vào thư viện của chính nó (bật trong cấu hình agent). */
  canWriteLibrary?: boolean;
  /** Xóa mục trong thư viện = chuyển vào thùng rác 30 ngày (runtime cung cấp). */
  libraryTrash?: (absPath: string) => Promise<void>;
  /**
   * Cô lập tool exec (bubblewrap): runtime dựng sẵn thư mục HOME riêng + chế độ.
   * Không có → exec chạy trực tiếp với biến môi trường đã lọc bí mật.
   */
  execSandbox?: ExecSandboxOptions;
  /**
   * Người dùng cuối trên kênh chat, dạng "<kind>-<senderId>" (vd "telegram-123").
   * Không có (chat HTTP/cron/webhook) = đường chạy operator.
   */
  userKey?: string;
  /**
   * Tạo link công khai có hạn cho 1 file trong vùng làm việc (tool publish_file).
   * Không có → tính năng tắt (thiếu PENAI_PUBLIC_URL).
   */
  publishFile?: (
    absPath: string,
    opts: { ttlSeconds: number; fileName: string },
  ) => Promise<{ url: string; expiresAt: string }>;
  /**
   * Recheck quyền MCP ngay trước khi gọi tool (fail-closed) — quyền có thể bị
   * thu hồi giữa phiên chat. Không có → bỏ qua recheck (đã lọc lúc build registry).
   */
  mcpGuard?: (serverId: string, toolName: string) => Promise<boolean>;
  /**
   * Gửi thẻ duyệt có nút bấm vào cuộc trò chuyện hiện tại (tool
   * send_approval_card). Trả id thẻ. Chỉ kênh hỗ trợ nút (Telegram, Teams).
   */
  approvalCard?: (input: {
    text: string;
    buttons: Array<{ label: string; value: string }>;
  }) => Promise<string>;
  /**
   * Gửi file cho người dùng qua kênh đang chat (Telegram...).
   * Không có → tool send_file báo chưa hỗ trợ.
   */
  attachFile?: (absPath: string) => void;
  /** Hủy lượt chạy (lệnh /stop) — tool chạy lâu như exec phải tôn trọng. */
  signal?: AbortSignal;
  /**
   * Xin phê duyệt hành động nguy hiểm (vd chạy shell). Trả true nếu được phép.
   * Mặc định (không cung cấp) = từ chối các hành động cần approval.
   */
  requestApproval?: (action: {
    tool: string;
    summary: string;
    detail?: string;
  }) => Promise<boolean>;
  /** Cho phép web_search dùng provider tìm kiếm (nếu cấu hình). */
  webSearch?: (query: string, limit: number) => Promise<string>;
  /** Tạo ảnh qua provider subscription — runtime dựng Antigravity → codex, qua ProviderGate. */
  generateImage?: (req: {
    prompt: string;
    size?: string;
    /** Tỷ lệ khung "16:9"… — thắng size. */
    aspectRatio?: string;
    /** Ảnh tham chiếu (data URL) — tạo/sửa ảnh dựa trên ảnh người dùng gửi. */
    refImages?: string[];
    /** Ép provider ("antigravity" | "codex"); bỏ trống = thứ tự mặc định. */
    provider?: string;
  }) => Promise<{ data: Buffer; mime: string; route?: string }>;
  /** Truy cập memory của agent (nếu bật). */
  memory?: {
    add(content: string, opts?: { importance?: number }): Promise<void>;
    search(query: string, limit?: number): Promise<string>;
    /** Đọc file ghi nhớ (MEMORY.md, memory/*.md) theo cửa sổ dòng. */
    getDoc?(path: string, fromLine?: number, lineCount?: number): Promise<string>;
    /**
     * fs-tools gọi sau khi ghi/sửa file ghi nhớ trên đĩa — runtime lưu bản
     * sao vào DB để memory_search tìm lại được. Best-effort, không throw.
     */
    saveDoc?(path: string, content: string): Promise<void>;
    /** fs-tools gọi khi file ghi nhớ bị xóa/di chuyển. */
    deleteDoc?(path: string): Promise<void>;
  };
  /** Truy cập skills của workspace (nếu bật). */
  skills?: {
    search(query: string, limit?: number): Promise<string>;
    get(slug: string): Promise<string>;
    /**
     * Đăng ký skill từ dữ liệu agent đã soạn (publish_skill).
     * Không có → agent không tự tạo skill được.
     */
    publish?(input: {
      slug: string;
      name: string;
      description: string;
      content: string;
      files: Array<{ path: string; contentB64: string }>;
    }): Promise<string>;
    /**
     * Sua co muc tieu mot skill co san: giu nguyen file khong duoc nhac den,
     * snapshot truoc khi doi va bat buoc agent co grant can_manage.
     */
    update?(input: {
      slug: string;
      content?: string;
      upsertFiles: Array<{ path: string; contentB64: string }>;
      deleteFiles: string[];
    }): Promise<string>;
  };
  /** Landing page HTML cong khai do agent tao/sua. */
  landingPages?: {
    save(input: { slug: string; title: string; html: string }): Promise<string>;
    list(query?: string): Promise<string>;
    get(slug: string): Promise<{ html: string; url: string; title: string; version: number } | null>;
  };
  /** Ủy quyền cho agent khác (subagent spawn) — trả kết quả. */
  delegate?: (toAgentKey: string, task: string) => Promise<string>;
  /** Bảng công việc nhóm (nếu agent thuộc team). */
  team?: {
    addTask(title: string, description: string): Promise<string>;
    nextTask(): Promise<string>;
    finishTask(taskId: string, result: string): Promise<string>;
    listTasks(): Promise<string>;
  };
  /** Knowledge vault (tài liệu). */
  vault?: {
    search(query: string): Promise<string>;
    /** offset: đọc tiếp từ ký tự thứ N (tài liệu dài trả theo cửa sổ lớn). */
    get(slug: string, offset?: number): Promise<string>;
    write(slug: string, title: string, content: string): Promise<string>;
  };
  /** Knowledge graph (đồ thị tri thức). */
  kg?: {
    search(name: string, depth?: number): Promise<string>;
  };
}

/** Tool định nghĩa bằng Zod (built-in). */
export interface ToolHandler<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  execute(args: z.infer<S>, toolCtx: ToolContext): Promise<string>;
}

/** Tool định nghĩa bằng JSON Schema trực tiếp (custom tools, MCP). */
export interface RawToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, toolCtx: ToolContext): Promise<string>;
}

export interface ToolExecuteResult {
  result: string;
  isError: boolean;
}

// Dạng chuẩn hóa nội bộ
interface NormTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  validate(args: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; error: string };
  run(args: unknown, ctx: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, NormTool>();

  register(tool: ToolHandler): this {
    this.add({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema) as Record<string, unknown>,
      validate: (args) => {
        const p = tool.schema.safeParse(args);
        return p.success ? { ok: true, value: p.data } : { ok: false, error: p.error.message };
      },
      run: (args, ctx) => tool.execute(args, ctx),
    });
    return this;
  }

  /** Đăng ký tool với JSON Schema trực tiếp (không validate chặt — tin LLM). */
  registerRaw(tool: RawToolHandler): this {
    this.add({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      validate: (args) => ({ ok: true, value: args }),
      run: (args, ctx) => tool.execute(args as Record<string, unknown>, ctx),
    });
    return this;
  }

  private add(t: NormTool): void {
    if (this.tools.has(t.name)) throw new Error(`Tool "${t.name}" đã đăng ký rồi`);
    this.tools.set(t.name, t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Gỡ tool (dùng để tắt tool per-agent). */
  remove(name: string): void {
    this.tools.delete(name);
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description }));
  }

  definitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Chạy tool theo tên. Mọi lỗi (không tồn tại, args sai, exception)
   * đều trả về isError=true — KHÔNG throw, để agent loop tiếp tục.
   */
  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    toolCtx: ToolContext,
  ): Promise<ToolExecuteResult> {
    const tool = this.tools.get(name);
    if (!tool) return { result: `Tool "${name}" không tồn tại`, isError: true };
    const v = tool.validate(rawArgs);
    if (!v.ok) {
      return { result: `Tham số không hợp lệ cho tool "${name}": ${v.error}`, isError: true };
    }
    try {
      const result = await tool.run(v.value, toolCtx);
      return { result, isError: false };
    } catch (err) {
      return { result: `Tool "${name}" lỗi: ${(err as Error).message}`, isError: true };
    }
  }
}
