import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret, encryptSecret, logger } from "@penai/shared";
import { listEnabledMcpServers, type DbHandle, type EnabledMcpServer } from "@penai/db";
import {
  McpConnection,
  UnauthorizedError,
  createOauthProvider,
  finishMcpAuth,
  type McpOauthSession,
  type McpRichResult,
  type McpTool,
} from "@penai/mcp";
import type { RawToolHandler } from "@penai/tools";

/** Phần giao diện của McpConnection mà manager cần — cho phép test inject bản giả. */
export interface McpConnectionLike {
  connect(cfg: Parameters<McpConnection["connect"]>[0]): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Bản giàu content (ảnh/link) — connection giả trong test có thể không có. */
  callToolRich?(name: string, args: Record<string, unknown>): Promise<McpRichResult>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

interface WsMcpTool {
  serverId: string;
  serverName: string;
  toolName: string; // tên gốc (không prefix) — dùng cho tool_allow
  visibility: "workspace" | "granted";
  handler: RawToolHandler;
}

/** Trạng thái 1 MCP server để hiển thị trong dashboard. */
export interface McpStatus {
  id: string;
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
  connectedAt?: string;
  /** Server yêu cầu OAuth — người dùng cần mở authUrl để đồng ý. */
  needsAuth?: boolean;
  authUrl?: string;
  lastPingAt?: string;
  reconnectAttempts?: number;
}

/** Bộ lọc tool cho 1 server: allow (null = mọi tool) + deny (deny luôn thắng). */
export interface McpToolFilter {
  allow: Set<string> | null;
  deny?: Set<string>;
}

/** Quyền MCP đã hợp nhất (agent ∩ user): serverId → bộ lọc tool. */
export type McpAccess = Map<string, McpToolFilter>;

// Health check + tự kết nối lại (ping định kỳ, lùi dần thời gian thử lại)
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_FAIL_THRESHOLD = 3; // số lần ping hỏng liên tiếp trước khi coi là chết
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_COOLDOWN_MS = 5 * 60_000; // hết 10 lần thì nghỉ 5 phút rồi thử lại

interface ServerRuntime {
  cfg: EnabledMcpServer;
  pingFailures: number;
  reconnectAttempts: number;
  nextRetryAt: number; // epoch ms; 0 = thử được ngay
}

export interface McpManagerDeps {
  /** Ghi OAuth session (đã mã hóa) xuống DB. Không có → OAuth tắt. */
  persistOauth?: (serverId: string, workspaceId: string, encrypted: string) => Promise<void>;
  /** redirect_uri cho OAuth, vd http://127.0.0.1:18800/oauth/mcp/callback */
  oauthRedirectUrl?: string;
  /** Test inject connection giả; mặc định tạo McpConnection thật. */
  connectionFactory?: (serverName: string) => McpConnectionLike;
}

/**
 * Quản lý kết nối tới các MCP server (stdio / sse / http).
 * Kết nối lúc boot, giữ kết nối, cung cấp tool theo workspace + quyền agent.
 * Tên tool được prefix `mcp__<server>__<tool>` tránh trùng.
 * - Kết nối lại từng server KHÔNG cần restart tiến trình.
 * - Health loop: ping 30s/lần, chết 3 lần liên tiếp → tự kết nối lại (backoff).
 * - OAuth (http/sse): SDK lo discovery + DCR + PKCE + refresh; dashboard hiện link đăng nhập.
 */
/** Tên server → đoạn hợp lệ trong tên tool (chỉ [a-zA-Z0-9_-]). */
export function sanitizeMcpName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return safe || "server";
}

export class McpManager {
  private conns = new Map<string, McpConnectionLike>(); // theo serverId
  private byWorkspace = new Map<string, WsMcpTool[]>();
  private status = new Map<string, McpStatus>();
  private runtimes = new Map<string, ServerRuntime>();
  private oauthStates = new Map<string, string>(); // state → serverId
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private deps: McpManagerDeps = {}) {}

  async start(db: DbHandle): Promise<void> {
    let servers;
    try {
      servers = await listEnabledMcpServers(db.db);
    } catch (err) {
      logger.warn(`MCP: không đọc được danh sách server — ${(err as Error).message}`);
      return;
    }
    for (const srv of servers) {
      await this.connectServer(srv);
    }
    this.startHealthLoop();
  }

  /** Kết nối (hoặc kết nối lại) 1 server. Trả về trạng thái sau khi thử. */
  async connectServer(srv: EnabledMcpServer): Promise<McpStatus> {
    await this.disconnectServer(srv.id);
    const rt: ServerRuntime = this.runtimes.get(srv.id) ?? {
      cfg: srv,
      pingFailures: 0,
      reconnectAttempts: 0,
      nextRetryAt: 0,
    };
    rt.cfg = srv;
    rt.pingFailures = 0;
    this.runtimes.set(srv.id, rt);

    const st: McpStatus = {
      id: srv.id,
      name: srv.name,
      transport: srv.transport,
      connected: false,
      toolCount: 0,
      tools: [],
    };
    try {
      const conn = this.deps.connectionFactory?.(srv.name) ?? new McpConnection(srv.name);
      const env = srv.envEncrypted ? parseEnv(decryptSecret(srv.envEncrypted)) : undefined;
      const authProvider = this.buildOauthProvider(srv, st);
      await conn.connect({
        transport: srv.transport,
        command: srv.command,
        args: srv.args,
        url: srv.url,
        // stdio: env là biến môi trường; http/sse: env dùng làm HTTP header
        ...(env && srv.transport === "stdio" ? { env } : {}),
        ...(env && srv.transport !== "stdio" ? { headers: env } : {}),
        ...(authProvider ? { authProvider } : {}),
      });
      const tools = await conn.listTools();
      this.conns.set(srv.id, conn);

      const list = this.byWorkspace.get(srv.workspaceId) ?? [];
      // Tên server phải sanitize khi ghép vào tên tool — provider (OpenAI/Anthropic)
      // chỉ chấp nhận [a-zA-Z0-9_-]; tên có dấu cách/unicode sẽ bị từ chối cả lượt chat.
      const safeName = sanitizeMcpName(srv.name);
      for (const t of tools) {
        list.push({
          serverId: srv.id,
          serverName: srv.name,
          toolName: t.name,
          visibility: srv.visibility,
          handler: {
            name: `mcp__${safeName}__${t.name}`,
            description: `[MCP:${srv.name}] ${t.description}`,
            parameters: t.inputSchema,
            execute: async (args, toolCtx) => {
              // Recheck quyền ngay trước khi gọi (quyền có thể bị thu hồi giữa phiên)
              if (toolCtx.mcpGuard && !(await toolCtx.mcpGuard(srv.id, t.name))) {
                return `Từ chối: bạn không (hoặc không còn) được phép dùng tool "${t.name}" của MCP "${srv.name}".`;
              }
              const rich: McpRichResult = conn.callToolRich
                ? await conn.callToolRich(t.name, args)
                : { text: await conn.callTool(t.name, args), images: [], links: [] };
              let out = rich.text;
              // Ảnh trả về từ MCP: lưu vào thư mục làm việc để agent gửi tiếp
              // được (send_file) — marker [[media:]] là fallback auto-send.
              for (const [i, img] of rich.images.entries()) {
                const ext =
                  img.mime === "image/jpeg" ? "jpg"
                  : img.mime === "image/webp" ? "webp"
                  : img.mime === "image/gif" ? "gif"
                  : "png";
                const file = `mcp-${safeName}-${Date.now()}${rich.images.length > 1 ? `-${i + 1}` : ""}.${ext}`;
                const abs = join(toolCtx.workDir ?? toolCtx.workspaceDataDir, file);
                try {
                  await writeFile(abs, img.data);
                  out += `\n[Đã lưu ảnh từ MCP vào thư mục làm việc: ${file}]\n[[media:${abs}]]`;
                } catch {
                  out += "\n[Không lưu được 1 ảnh từ MCP]";
                }
              }
              return out;
            },
          },
        });
      }
      this.byWorkspace.set(srv.workspaceId, list);

      st.connected = true;
      st.toolCount = tools.length;
      st.tools = tools.map((t) => t.name);
      st.connectedAt = new Date().toISOString();
      rt.reconnectAttempts = 0;
      rt.nextRetryAt = 0;
      logger.info(`MCP "${srv.name}" (${srv.transport}): kết nối OK, ${tools.length} tool`);
    } catch (err) {
      // Lỗi phải nhìn thấy được trong dashboard, không chỉ nằm trong log
      if (err instanceof UnauthorizedError && st.authUrl) {
        st.needsAuth = true;
        st.error = "Cần đăng nhập OAuth — mở link đăng nhập trong dashboard";
        logger.info(`MCP "${srv.name}": chờ người dùng đăng nhập OAuth`);
      } else {
        st.error = (err as Error).message;
        logger.warn(`MCP "${srv.name}": kết nối lỗi — ${st.error}`);
      }
    }
    st.reconnectAttempts = rt.reconnectAttempts;
    this.status.set(srv.id, st);
    return st;
  }

  /** Ngắt 1 server và gỡ tool của nó khỏi các workspace. */
  async disconnectServer(serverId: string): Promise<void> {
    const conn = this.conns.get(serverId);
    if (conn) {
      await conn.close().catch(() => {});
      this.conns.delete(serverId);
    }
    for (const [ws, list] of this.byWorkspace) {
      this.byWorkspace.set(
        ws,
        list.filter((t) => t.serverId !== serverId),
      );
    }
  }

  /** Xóa hẳn server (khi bị xóa trong dashboard) — dừng cả auto-reconnect. */
  async removeServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    this.runtimes.delete(serverId);
    this.status.delete(serverId);
    for (const [state, id] of this.oauthStates) {
      if (id === serverId) this.oauthStates.delete(state);
    }
  }

  // ===== OAuth =====

  private buildOauthProvider(srv: EnabledMcpServer, st: McpStatus) {
    if (!this.deps.persistOauth || !this.deps.oauthRedirectUrl) return undefined;
    if (srv.transport === "stdio") return undefined;
    let session: McpOauthSession | null = null;
    if (srv.oauthEncrypted) {
      try {
        session = JSON.parse(decryptSecret(srv.oauthEncrypted)) as McpOauthSession;
      } catch {
        session = null; // master key đổi / dữ liệu hỏng → đăng nhập lại
      }
    }
    const state = randomUUID();
    this.oauthStates.set(state, srv.id);
    const persistOauth = this.deps.persistOauth;
    return createOauthProvider({
      redirectUrl: this.deps.oauthRedirectUrl,
      state,
      session,
      persist: async (s) => {
        const rt = this.runtimes.get(srv.id);
        if (rt) {
          rt.cfg = { ...rt.cfg, oauthEncrypted: encryptSecret(JSON.stringify(s)) };
          await persistOauth(srv.id, srv.workspaceId, rt.cfg.oauthEncrypted!);
        }
      },
      onRedirect: (authUrl) => {
        st.authUrl = authUrl;
        st.needsAuth = true;
      },
    });
  }

  /**
   * Callback OAuth: đổi code lấy token rồi kết nối lại server.
   * Trả về status sau khi kết nối, hoặc null nếu state không khớp.
   */
  async completeOauth(state: string, code: string): Promise<McpStatus | null> {
    const serverId = this.oauthStates.get(state);
    if (!serverId) return null;
    this.oauthStates.delete(state);
    const rt = this.runtimes.get(serverId);
    if (!rt || !rt.cfg.url) return null;
    const st = this.status.get(serverId);
    const provider = this.buildOauthProvider(rt.cfg, st ?? ({} as McpStatus));
    if (!provider) return null;
    await finishMcpAuth({ transport: rt.cfg.transport, url: rt.cfg.url }, provider, code);
    // token đã lưu vào rt.cfg.oauthEncrypted qua persist → kết nối lại bằng cfg mới
    return this.connectServer(rt.cfg);
  }

  // ===== Health check + auto reconnect =====

  startHealthLoop(): void {
    if (this.healthTimer || this.stopped) return;
    this.healthTimer = setInterval(() => {
      void this.healthTick().catch((err) => {
        logger.warn(`MCP health loop lỗi: ${(err as Error).message}`);
      });
    }, HEALTH_INTERVAL_MS);
    // không giữ process sống chỉ vì health loop
    this.healthTimer.unref?.();
  }

  /** 1 vòng health check — public để test gọi trực tiếp không cần chờ timer. */
  async healthTick(now = Date.now()): Promise<void> {
    for (const [id, rt] of this.runtimes) {
      const st = this.status.get(id);
      const conn = this.conns.get(id);
      if (conn && st?.connected) {
        const alive = await conn.ping();
        st.lastPingAt = new Date(now).toISOString();
        if (alive) {
          rt.pingFailures = 0;
          continue;
        }
        rt.pingFailures++;
        if (rt.pingFailures < HEALTH_FAIL_THRESHOLD) continue;
        logger.warn(`MCP "${rt.cfg.name}": ${rt.pingFailures} lần ping hỏng — kết nối lại`);
        st.connected = false;
        st.error = "Mất kết nối (ping hỏng) — đang tự kết nối lại";
        await this.disconnectServer(id);
      }
      // Đến đây: server chưa/mất kết nối → thử lại theo backoff.
      // Server đang chờ người dùng đăng nhập OAuth thì không tự thử (vô ích).
      if (st?.needsAuth) continue;
      if (now < rt.nextRetryAt) continue;
      rt.reconnectAttempts++;
      if (rt.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        rt.reconnectAttempts = 0;
        rt.nextRetryAt = now + RECONNECT_COOLDOWN_MS;
        logger.warn(`MCP "${rt.cfg.name}": quá ${MAX_RECONNECT_ATTEMPTS} lần thử — nghỉ 5 phút`);
        continue;
      }
      const backoff = Math.min(
        RECONNECT_BASE_MS * 2 ** (rt.reconnectAttempts - 1),
        RECONNECT_MAX_MS,
      );
      rt.nextRetryAt = now + backoff;
      const res = await this.connectServer(rt.cfg);
      if (res.connected) {
        logger.info(`MCP "${rt.cfg.name}": tự kết nối lại thành công`);
      }
    }
  }

  /** Thử kết nối theo cấu hình tạm (nút "Kiểm tra" trước khi lưu). */
  static async testConnection(cfg: {
    name: string;
    transport: string;
    command?: string | null;
    args?: string[];
    url?: string | null;
    env?: Record<string, string>;
  }): Promise<{ ok: boolean; tools: string[]; error?: string }> {
    const conn = new McpConnection(cfg.name || "test");
    try {
      const { env, ...rest } = cfg;
      await conn.connect({
        ...rest,
        // stdio: env là biến môi trường; http/sse: env dùng làm HTTP header
        ...(env && cfg.transport === "stdio" ? { env } : {}),
        ...(env && cfg.transport !== "stdio" ? { headers: env } : {}),
      });
      const tools = await conn.listTools();
      return { ok: true, tools: tools.map((t) => t.name) };
    } catch (err) {
      return { ok: false, tools: [], error: (err as Error).message };
    } finally {
      await conn.close().catch(() => {});
    }
  }

  /**
   * Tool MCP cho 1 workspace, lọc theo quyền đã hợp nhất (agent ∩ user).
   * - access=undefined (không rõ agent): chỉ server visibility=workspace.
   * - access có: chỉ server trong map; tool phải qua allow (null = mọi tool)
   *   và không nằm trong deny (deny luôn thắng).
   */
  toolsFor(workspaceId: string, access?: McpAccess): RawToolHandler[] {
    const list = this.byWorkspace.get(workspaceId) ?? [];
    return list
      .filter((t) => {
        if (!access) return t.visibility === "workspace";
        const f = access.get(t.serverId);
        if (f === undefined) return false; // không có quyền server này
        if (f.deny?.has(t.toolName)) return false;
        return f.allow === null || f.allow.has(t.toolName);
      })
      .map((t) => t.handler);
  }

  /** Trạng thái mọi server (cho dashboard). */
  statuses(): McpStatus[] {
    return [...this.status.values()];
  }

  statusOf(serverId: string): McpStatus | undefined {
    return this.status.get(serverId);
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    await Promise.allSettled([...this.conns.values()].map((c) => c.close()));
    this.conns.clear();
    this.byWorkspace.clear();
    this.status.clear();
    this.runtimes.clear();
    this.oauthStates.clear();
  }
}

/**
 * Chuỗi env: mỗi dòng "KEY=value" (khuyến nghị) hoặc phân tách bằng ";".
 * Tách theo dòng trước để giá trị chứa ";" (connection string) không bị cắt.
 */
export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = raw.includes("\n") ? raw.split(/\r?\n/) : raw.split(";");
  for (const pair of parts) {
    const line = pair.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
