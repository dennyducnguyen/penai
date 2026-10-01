import { mkdir, readFile as fsReadFile, readdir, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  encryptSecret,
  decryptSecret,
  canChat,
  hasRole,
  isValidTimeZone,
  logger,
  type WorkspaceContext,
  type WorkspaceRole,
  type PenaiConfig,
} from "@penai/shared";
import {
  authenticateApiKey,
  canAccessAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgentById,
  getBrowserProfile,
  getAgentByKey,
  getSession,
  listAgents,
  listSessions,
  loadMessages,
  appendMessage,
  createSession,
  createChannel,
  listChannels,
  exportContacts,
  listAllZaloThreads,
  deleteChannel,
  getChannelById,
  getChannelSession,
  mapChannelSession,
  updateChannel,
  approvePairing,
  listPendingPairings,
  listContacts,
  listZaloObservedPeers,
  listContactsOverview,
  getContactOverview,
  findContactIdentity,
  getPrincipalProfile,
  upsertPrincipalProfile,
  listContactTags,
  createContactTag,
  updateContactTag,
  deleteContactTag,
  listPrincipalTags,
  setPrincipalTags,
  listMemoriesForUserKey,
  getPersonRelated,
  type DbHandle,
} from "@penai/db";
import {
  createCronJob,
  listCronJobs,
  getCronJob,
  updateCronJob,
  deleteCronJob,
  listCronRuns,
  addMemory,
  listMemories,
  listMemoryUserKeys,
  searchMemories,
  updateMemory,
  pruneMemories,
  deleteMemory,
  addWorkspaceSemanticMemory,
  listWorkspaceSemanticMemories,
  searchWorkspaceSemanticMemories,
  updateWorkspaceSemanticMemory,
  deleteWorkspaceSemanticMemory,
  listMemoryDocs,
  getMemoryDocById,
  deleteMemoryDocById,
  createSkill,
  listSkills,
  updateSkill,
  deleteSkill,
  toggleSkill,
  setSkillVisibility,
  grantSkillToAgent,
  getSkillBySlug,
  getSkillById,
  listSkillFiles,
  upsertSkillFile,
  deleteSkillFile,
  replaceSkillFiles,
  snapshotSkill,
  bumpSkillVersion,
  listSkillVersions,
  getSkillVersion,
  listAgentsWithSkillGrant,
  revokeSkillFromAgent,
  listSkillsWithGrantStatus,
  createLlmProvider,
  listLlmProviders,
  updateLlmProvider,
  deleteLlmProvider,
  countAgentsUsingProvider,
  createCustomTool,
  listCustomTools,
  deleteCustomTool,
  createMcpServer,
  listMcpServers,
  deleteMcpServer,
  setMcpVisibility,
  setMcpUserPolicy,
  grantMcpToAgent,
  revokeMcpFromAgent,
  listMcpWithGrantStatus,
  upsertMcpUserGrant,
  revokeMcpUserGrant,
  listMcpUserGrants,
  getPublishedFileByHash,
  getPublicLandingPage,
  createPublishedFile,
  listPublishedFiles,
  revokePublishedFile,
  createTeam,
  listTeams,
  addTeamMember,
  listTeamMembers,
  createTeamTask,
  listTeamTasks,
  createAgentLink,
  listVaultDocs,
  getVaultDoc,
  deleteVaultDoc,
  createVaultCollection,
  deleteVaultCollection,
  getOrCreateMemberPrincipal,
  getVaultSettings,
  listConversations,
  listPrincipals,
  listVaultAccessAgents,
  listVaultCollectionGrants,
  listVaultCollections,
  replaceVaultCollectionGrants,
  updateVaultCollection,
  updateVaultSettings,
  listEntities,
  upsertEntity,
  addRelation,
  traverseGraph,
  recordTrace,
  recordTraceSafe,
  listTraces,
  setUsageCap,
  monthTokens,
  workspaceCap,
  isOverCap,
  createHook,
  listHooks,
  deleteHook,
  createAgentWebhook,
  listAgentWebhooks,
  lookupAgentWebhook,
  consumeNonce,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteSession,
  recordAudit,
  listAudit,
} from "@penai/db";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  describeSchedule,
  formatInZone,
  minIntervalMs,
  nextRun,
  normalizeSchedule,
} from "@penai/core";
import { CRON_MIN_INTERVAL_MS, deliverLabel } from "./cron-tools.js";
import {
  isChannelKindSupported,
  supportedChannelKinds,
  parseWhatsappWebhook,
  parseZaloWebhook,
  parseFeishuWebhook,
  ZaloPersonalChannel,
  TeamsChannel,
  parseTeamsActivity,
  parseTeamsCardAction,
  verifyTeamsJwt,
} from "@penai/channels";
import fastifyWebsocket from "@fastify/websocket";
import { buildLoopDeps, agentOpts, reasoningEffortOf, contentTypeOf, sanitizeUserKey } from "./agent-runtime.js";
import { PERSON_LIMITS } from "./person-context.js";
import { registerApiRoutes } from "./api/index.js";
import { consolidateSession } from "./memory-worker.js";
import { channelHandlers, applyChannelChange, scheduleOnChannelQueue, dispatchChannelCallback } from "./channels-runtime.js";
import {
  createOutboundCollector,
  describeOutbound,
  filesMarker,
  prepareWebInbound,
  resolveDownload,
  sendDownload,
  webDirs,
  webUserKey,
  WEB_FILES_MAX,
  type WebAttachmentIn,
} from "./web-chat.js";
import {
  KeyedQueue,
  ProviderGate,
  composeSystemPrompt,
  runAgent,
  runAgentText,
  type AgentEvent,
} from "@penai/core";
import { INDEX_HTML } from "./ui.js";
import { customLogoType, defaultLogoSvg, renderIndexHtml } from "./branding.js";
import { RELEASE } from "./version.js";
import {
  CodexProvider,
  AnthropicProvider,
  AntigravityProvider,
  ClaudeCodeProvider,
  GeminiProvider,
  OpenAICompatProvider,
  QwenProvider,
  isEmbeddingProvider,
  startLoginFlow,
  parseCodexCallback,
  type LoginFlow,
  type ProviderRegistry,
} from "@penai/providers";
import { registerDbProvider } from "./providers-runtime.js";
import {
  hybridVaultSearch,
  indexVaultDocument,
  reindexVault,
  writeAndIndexVaultDocument,
} from "./vault-runtime.js";
import {
  assertRealPathInside,
  extractDocumentText,
  parseSkillFrontmatter,
  slugify,
  type ToolRegistry,
} from "@penai/tools";
import { McpManager, parseEnv } from "./mcp-manager.js";
import {
  materializeSkill,
  removeSkillDir,
  readSkillZip,
  buildSkillZip,
  sanitizeSkillPath,
} from "./skills-fs.js";
import {
  allowedWhileMustChange,
  isCrossSiteMutation,
  memberAllowed,
  registerAuthRoutes,
  resolveRequestAuth,
  type ResolvedAuth,
} from "./web-auth.js";
import { registerLibraryRoutes } from "./library.js";
import { registerZaloInboxRoutes } from "./zalo-inbox.js";
import { buildXlsx, type XlsxCell } from "./xlsx.js";
import { isMcpPublicPath, registerMcpServerRoutes } from "./mcp-server.js";
import { registerBrowserRoutes } from "./browser-runtime.js";

declare module "fastify" {
  interface FastifyRequest {
    authCtx: WorkspaceContext;
    /** Chi tiết xác thực (API key hay phiên web) — xem web-auth.ts */
    authInfo?: ResolvedAuth;
  }
}

/** Kiểu tối giản cho WebSocket của @fastify/websocket (tránh phụ thuộc types 'ws'). */
interface WsLike {
  on(event: "message", cb: (data: Buffer) => void): void;
  send(data: string): void;
  close(): void;
}

export interface AppDeps {
  db: DbHandle;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  config: PenaiConfig;
  mcp?: McpManager;
  /** Tran dong thoi theo provider, dung chung voi kenh chat/cron. */
  gate?: ProviderGate;
}

/** Lỗi Zod → thông báo tiếng Việt ngắn gọn (thay vì JSON thô khó đọc). */
/**
 * File trong thư mục riêng của một người (ảnh/tài liệu họ gửi, file AI tạo) —
 * mới nhất trước. Không đi theo symlink; tối đa 200 file.
 */
async function listPersonFiles(
  dir: string,
): Promise<Array<{ path: string; bytes: number; modifiedAt: string }>> {
  const out: Array<{ path: string; bytes: number; modifiedAt: string }> = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4 || out.length >= 500) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = join(d, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.isFile()) {
        const st = await stat(abs).catch(() => null);
        if (st) {
          out.push({
            path: relative(dir, abs).split(sep).join("/"),
            bytes: st.size,
            modifiedAt: st.mtime.toISOString(),
          });
        }
      }
      if (out.length >= 500) return;
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 200);
}

function zodMessage(err: z.ZodError): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of err.issues) {
    const field = issue.path.join(".") || "dữ liệu";
    if (seen.has(field)) continue;
    seen.add(field);
    let why = issue.message;
    if (issue.code === "too_small") why = "không được để trống";
    else if (issue.code === "invalid_format") why = "sai định dạng";
    else if (issue.code === "invalid_type") why = "thiếu hoặc sai kiểu";
    parts.push(`${field}: ${why}`);
  }
  return "Dữ liệu không hợp lệ — " + parts.join(" · ");
}

function providerErrorMessage(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401) return "API key không hợp lệ hoặc đã bị thu hồi";
  if (status === 403) return "API key không có quyền truy cập model";
  if (status === 429) return "Tài khoản provider đã hết quota hoặc đang bị giới hạn";
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/sk-[A-Za-z0-9._-]+/g, "[API_KEY]")
    .replace(/AQ\.[A-Za-z0-9._-]+/g, "[API_KEY]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[API_KEY]")
    .slice(0, 500);
}

function databaseErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string") return value.code;
    current = value.cause;
  }
  return undefined;
}

function normalizedProviderBaseUrl(
  kind: z.infer<typeof ProviderKindSchema>,
  raw?: string | null,
): string | undefined {
  const baseUrl = raw?.trim() || undefined;
  if (kind === "openai" || kind === "gemini") {
    if (baseUrl) throw new Error(`${kind} dùng endpoint chính thức, không nhận Base URL tùy chỉnh`);
    return undefined;
  }
  if (kind === "qwen") {
    if (!baseUrl) return undefined;
    const url = new URL(baseUrl);
    const validHost = url.hostname === "aliyuncs.com" || url.hostname.endsWith(".aliyuncs.com");
    if (url.protocol !== "https:" || !validHost || !/\/compatible-mode\/v1\/?$/.test(url.pathname)) {
      throw new Error("Qwen Base URL phải là endpoint HTTPS ...aliyuncs.com/compatible-mode/v1");
    }
    return baseUrl.replace(/\/$/, "");
  }
  if (kind === "openai-compat" && !baseUrl) {
    throw new Error("Provider OpenAI-compatible tùy chỉnh cần Base URL");
  }
  if (baseUrl) {
    const url = new URL(baseUrl);
    const localTest = process.env.NODE_ENV === "test" && ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !localTest) {
      throw new Error("Base URL tùy chỉnh phải dùng HTTPS");
    }
    return baseUrl.replace(/\/$/, "");
  }
  return undefined;
}

const CreateAgentBody = z.object({
  key: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  systemPrompt: z.string().default(""),
  provider: z.string().min(1),
  model: z.string().min(1),
  maxIterations: z.number().int().min(1).max(50).optional(),
  workspaceMemoryEnabled: z.boolean().optional(),
});

const FallbackSchema = z.array(z.object({ provider: z.string(), model: z.string() }));

const CreateSessionBody = z.object({
  agentKey: z.string().min(1),
  title: z.string().optional(),
});

const ChatBody = z.object({
  sessionId: z.string().uuid(),
  message: z.string().default(""),
  stream: z.boolean().default(false),
  /** File đính kèm từ web (ảnh → vision/refImages, tài liệu → read_document). */
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        contentB64: z.string().min(1),
        mime: z.string().max(100).optional(),
      }),
    )
    .max(WEB_FILES_MAX)
    .optional(),
});

const CreateCronBody = z.object({
  agentKey: z.string().min(1),
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  kind: z.enum(["cron", "heartbeat"]).default("cron"),
  /** Múi giờ IANA của lịch; bỏ trống = config.timezone. */
  timezone: z.string().trim().min(1).optional(),
});

const UpdateCronBody = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  schedule: z.string().trim().min(1).max(100).optional(),
  prompt: z.string().trim().min(1).optional(),
});

const CreateChannelBody = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  agentKey: z.string().min(1),
  token: z.string().optional().default(""),
  requirePairing: z.boolean().default(true),
  /** Cấu hình riêng theo kind (vd msteams: { appId, tenantId }). */
  config: z.record(z.string(), z.unknown()).optional(),
});

const UpdateChannelBody = z.object({
  name: z.string().min(1).optional(),
  agentKey: z.string().min(1).optional(),
  /** Bỏ trống/không gửi = giữ token cũ. */
  token: z.string().optional(),
  requirePairing: z.boolean().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const ZaloPersonalTestBody = z.object({
  threadId: z.string().min(1),
  peerKind: z.enum(["direct", "group"]),
  text: z.string().min(1).max(10_000),
});

const ZaloDemoThreadsBody = z.object({
  threads: z
    .array(
      z
        .string()
        .regex(/^(group|direct):\S+$/, 'Mỗi thread phải có dạng "group:<id>" hoặc "direct:<id>"'),
    )
    .max(20),
});

const UpdateAgentBody = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  providerFallback: FallbackSchema.optional(),
  disabledTools: z.array(z.string()).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
  workspaceMemoryEnabled: z.boolean().optional(),
  /** Cho agent ghi vào thư viện file của chính nó (mặc định chỉ đọc). */
  libraryWritable: z.boolean().optional(),
  /** Hồ sơ trình duyệt (Dashboard → Trình duyệt) cho tool browser; null = trình duyệt trống. */
  browserProfileId: z.string().uuid().nullable().optional(),
});

const CreateWorkspaceMemoryBody = z.object({
  content: z.string().trim().min(1).max(20_000),
  importance: z.number().min(0).max(1).default(0.8),
  pinned: z.boolean().default(false),
});

const UpdateWorkspaceMemoryBody = z
  .object({
    content: z.string().trim().min(1).max(20_000).optional(),
    importance: z.number().min(0).max(1).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Không có trường nào để sửa");

const ProviderKindSchema = z.enum(["openai", "gemini", "qwen", "openai-compat", "anthropic"]);
const ProviderCredentialBody = z.object({
  kind: ProviderKindSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1),
  chatModel: z.string().min(1).optional(),
  embeddingModel: z.string().min(1).optional(),
  embeddingDimensions: z.number().int().min(64).max(4096).optional(),
});
const CreateProviderBody = ProviderCredentialBody.extend({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((value) => slugify(value))
    .pipe(z.string().min(1).max(60)),
  defaultModel: z.string().optional(),
  defaultEmbeddingModel: z.string().optional(),
  embeddingDimensions: z.number().int().min(64).max(4096).optional(),
  isDefaultEmbedding: z.boolean().optional(),
});

const UpdateProviderBody = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().nullable().optional(),
    defaultModel: z.string().nullable().optional(),
    defaultEmbeddingModel: z.string().nullable().optional(),
    embeddingDimensions: z.number().int().min(64).max(4096).nullable().optional(),
    isDefaultEmbedding: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Không có trường nào để sửa");

const EmbeddingBody = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  inputs: z.array(z.string().min(1).max(20_000)).min(1).max(128),
  dimensions: z.number().int().min(64).max(4096).optional(),
  inputType: z.enum(["query", "document", "classification"]).optional(),
  title: z.string().max(1000).optional(),
});

const VaultSettingsBody = z
  .object({
    chunkTokens: z.number().int().min(100).max(4000),
    chunkOverlapTokens: z.number().int().min(0).max(1000),
    contextTokens: z.number().int().min(500).max(64000),
    retrievalLimit: z.number().int().min(1).max(30),
    autoRetrieve: z.boolean(),
    fullDocTokens: z.number().int().min(500).max(64000),
  })
  .refine((v) => v.chunkOverlapTokens < v.chunkTokens, {
    message: "Overlap phải nhỏ hơn kích thước chunk",
  });

const VaultCollectionBody = z.object({
  slug: z.string().trim().min(1).max(80).transform((v) => slugify(v)),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

const VaultCollectionPatchBody = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(4000).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    enabled: z.boolean().optional(),
    retrievalMode: z.enum(["auto", "always_full", "search_only"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Không có trường nào để sửa");

// File 100 MiB ma hoa base64 can khoang 133.4 MiB request JSON.
const UPLOAD_FILE_MAX_BYTES = 100 * 1024 * 1024;
const UPLOAD_BODY_MAX_BYTES = 140 * 1024 * 1024;

// Upload file văn phòng vào Kho tri thức (nội dung gửi dạng base64)
const VaultUploadBody = z.object({
  collectionId: z.string().uuid().optional(),
  files: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(300),
        contentB64: z.string().min(1).max(UPLOAD_BODY_MAX_BYTES),
      }),
    )
    .min(1)
    .max(20),
});

const VaultGrantBody = z
  .object({
    agentId: z.string().uuid().optional(),
    audienceType: z.enum(["all", "principal", "conversation", "role"]),
    principalId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    role: z.enum(["ws_admin", "operator", "viewer"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.audienceType === "principal" && !v.principalId) ctx.addIssue({ code: "custom", message: "Thiếu principalId" });
    if (v.audienceType === "conversation" && !v.conversationId) ctx.addIssue({ code: "custom", message: "Thiếu conversationId" });
    if (v.audienceType === "role" && !v.role) ctx.addIssue({ code: "custom", message: "Thiếu role" });
  });

const VaultDocumentBody = z.object({
  slug: z.string().trim().min(1).max(120).transform((v) => slugify(v)),
  title: z.string().trim().min(1).max(500),
  content: z.string().min(1).max(2_000_000),
  collectionId: z.string().uuid().optional(),
});

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: UPLOAD_BODY_MAX_BYTES });

  // Fastify chạy với logger: false nên lỗi ném ra từ route (kể cả 500) trước đây
  // KHÔNG ra journal — chẩn đoán phải xuống DB. Ghi mọi lỗi route bằng pino và
  // trả JSON { error } thống nhất với phần còn lại của API.
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    const status = typeof e.statusCode === "number" && e.statusCode >= 400 ? e.statusCode : 500;
    const meta = { method: req.method, url: req.url, status, code: e.code, route: req.routeOptions?.url };
    if (status >= 500) logger.error({ ...meta, err: e }, `Route lỗi ${status}: ${e.message}`);
    else logger.warn(meta, `Route từ chối ${status}: ${e.message}`);
    if (reply.sent) return;
    reply.code(status).send({ error: status >= 500 ? `Lỗi máy chủ: ${e.message}` : e.message });
  });
  const queue = new KeyedQueue();
  const { db } = deps.db;

  // ===== Auth: API key (Bearer) HOẶC phiên web (cookie) → WorkspaceContext (fail-closed) =====
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    // public: UI, health; /ws tự xác thực; webhook có xác thực riêng
    if (
      path === "/" ||
      path === "/healthz" ||
      path.startsWith("/brand/") || // logo/favicon trang đăng nhập
      path === "/ws" ||
      path === "/auth/login" || // đăng nhập email + mật khẩu
      path === "/auth/logout" || // tự đọc cookie, luôn cho phép
      path === "/oauth/mcp/callback" || // redirect từ trang OAuth của MCP server
      path.startsWith("/f/") || // link file công khai — token ngẫu nhiên là bằng chứng
      path.startsWith("/landing/") || // landing page public, HTML chay trong CSP sandbox
      path.startsWith("/webhooks/") ||
      isMcpPublicPath(path) // PenAI MCP server + OAuth: tự xác thực bằng token riêng (mcp-server.ts)
    )
      return;
    const resolved = await resolveRequestAuth(db, req);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: resolved.error });
    }
    req.authInfo = resolved.auth;
    req.authCtx = resolved.auth.ctx;
    if (resolved.auth.kind === "web") {
      if (isCrossSiteMutation(req)) {
        return reply.code(403).send({ error: "Yêu cầu cross-site bị từ chối" });
      }
      if (resolved.auth.mustChangePassword && !allowedWhileMustChange(path)) {
        return reply
          .code(403)
          .send({ error: "Bạn cần đổi mật khẩu trước khi tiếp tục", code: "must_change_password" });
      }
    }
    // Role member: allowlist fail-closed — chỉ chat với agent được gán
    if (req.authCtx.role === "member" && !memberAllowed(req.method, path)) {
      return reply.code(403).send({ error: "Tài khoản của bạn chỉ được dùng trang Chat" });
    }
  });

  function requireRole(
    req: FastifyRequest,
    reply: FastifyReply,
    min: WorkspaceRole,
  ): boolean {
    if (!hasRole(req.authCtx.role, min)) {
      void reply.code(403).send({ error: `Cần quyền ${min} trở lên` });
      return false;
    }
    return true;
  }

  /** Được chat: operator trở lên HOẶC member (agent được gán kiểm ở tầng repo). */
  function requireChat(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!canChat(req.authCtx.role)) {
      void reply.code(403).send({ error: "Cần quyền operator trở lên hoặc tài khoản thành viên" });
      return false;
    }
    return true;
  }

  // Đăng nhập / người dùng / phân quyền agent theo user (0024)
  registerAuthRoutes(app, { db, getAuth: (req) => req.authInfo });

  // API cong khai OpenAI-compatible (specs/spec-public-api-gateway.md).
  // Dung CHUNG ProviderGate voi kenh chat/cron: tran dong thoi khong duoc
  // cong don theo tung loi vao, neu khong luu luong app se bop nghet nguoi that.
  registerApiRoutes(app, { rt: deps, gate: deps.gate ?? new ProviderGate() });

  // Thư viện file của agent (Dashboard → Thư viện file) — operator trở lên
  registerLibraryRoutes(app, { db, dataDir: deps.config.dataDir });

  // Inbox Zalo cá nhân (trực chat nhiều người) + PenAI MCP server (Claude/ChatGPT gọi vào)
  registerZaloInboxRoutes(app, { db, dataDir: deps.config.dataDir });
  registerMcpServerRoutes(app, { db, dataDir: deps.config.dataDir, config: deps.config });

  // Trình duyệt của agent: hồ sơ cookie, thử truy cập, phiên đang mở (ws_admin)
  registerBrowserRoutes(app, { db });

  // Phiên bản kèm theo để lệnh cập nhật kiểm tra đúng bản mới đã chạy.
  app.get("/healthz", async () => ({ ok: true, version: RELEASE.version, ...(RELEASE.commit ? { commit: RELEASE.commit } : {}) }));

  // Logo thương hiệu: file riêng (branding.logoFile) hoặc SVG mặc định theo màu theme.
  // CSP chặn script trong file SVG khi ai đó mở thẳng link logo (cùng origin Dashboard).
  const LOGO_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  // Đọc config lúc gọi để đổi thương hiệu trong file cấu hình có hiệu lực ngay (hot-reload).
  app.get("/brand/logo.svg", async (_req, reply) => {
    return reply
      .type("image/svg+xml; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .header("content-security-policy", LOGO_CSP)
      .send(defaultLogoSvg(deps.config.branding));
  });
  app.get("/brand/logo", async (_req, reply) => {
    const b = deps.config.branding;
    const type = customLogoType(b);
    if (!type || !b.logoFile) return reply.redirect("/brand/logo.svg");
    return reply
      .type(type)
      .header("cache-control", "public, max-age=300")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", LOGO_CSP)
      .send(await fsReadFile(b.logoFile));
  });

  // Landing page public. Cho phep inline CSS/JS theo yeu cau, nhung KHONG cap
  // allow-same-origin: document mang opaque origin, khong doc duoc cookie,
  // localStorage hay goi API Dashboard nhu mot trang cung origin binh thuong.
  app.get("/landing/:id/:slug", async (req, reply) => {
    const { id } = req.params as { id: string; slug: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Landing page khong ton tai");
    }
    const page = await getPublicLandingPage(db, id);
    if (!page) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Landing page khong ton tai");
    }
    return reply
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "public, max-age=60")
      .header(
        "content-security-policy",
        "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; " +
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; " +
          "img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; " +
          "connect-src https:; frame-src https:; form-action https:; base-uri 'none'; object-src 'none'",
      )
      .type("text/html; charset=utf-8")
      .send(page.html);
  });

  // Trang chat thử nghiệm cho trình duyệt (public, không lộ dữ liệu)
  app.get("/", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderIndexHtml(INDEX_HTML, deps.config.branding));
  });

  // ===== WhatsApp Cloud API webhook =====
  // GET: xác minh (hub.challenge). POST: nhận tin → route qua onInbound → reply.
  app.get("/webhooks/whatsapp/:channelId", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const entry = channelHandlers.get((req.params as { channelId: string }).channelId);
    const verifyToken =
      (entry?.channel as { kind: string } | undefined) &&
      // verify token nằm trong config channel; đọc từ handler entry không có
      // → chấp nhận nếu hub.mode=subscribe và có challenge (đơn giản hóa local).
      q["hub.mode"] === "subscribe";
    if (verifyToken && q["hub.challenge"]) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send("forbidden");
  });

  // Webhook chung cho các kênh webhook-driven (zalo, feishu)
  const handleChannelWebhook = async (
    channelId: string,
    msgs: ReturnType<typeof parseWhatsappWebhook>,
  ) => {
    const entry = channelHandlers.get(channelId);
    if (!entry) return;
    for (const m of msgs) {
      try {
        const res = await entry.handler(m);
        if (res.kind === "reply" || res.kind === "pairing") {
          await entry.channel.send({ chatKey: m.chatKey, text: res.text });
        }
      } catch {
        // log qua onError
      }
    }
  };

  app.post("/webhooks/zalo/:channelId", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    void handleChannelWebhook(channelId, parseZaloWebhook(channelId, req.body));
    return reply.send({ ok: true });
  });

  app.post("/webhooks/feishu/:channelId", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const body = req.body as { type?: string; challenge?: string };
    // Feishu URL verification
    if (body?.type === "url_verification" && body.challenge) {
      return reply.send({ challenge: body.challenge });
    }
    void handleChannelWebhook(channelId, parseFeishuWebhook(channelId, req.body));
    return reply.send({ ok: true });
  });

  // Agent webhook: hệ ngoài trigger agent (HMAC + nonce chống replay)
  app.post("/webhooks/agent/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wh = await lookupAgentWebhook(db, id);
    if (!wh || !wh.enabled) return reply.code(404).send({ error: "webhook không tồn tại" });

    const sig = req.headers["x-penai-signature"] as string | undefined;
    const ts = req.headers["x-penai-timestamp"] as string | undefined;
    const nonce = req.headers["x-penai-nonce"] as string | undefined;
    if (!sig || !ts || !nonce) return reply.code(401).send({ error: "thiếu header ký" });
    // chống replay theo thời gian (±5 phút)
    if (Math.abs(Date.now() - Number(ts)) > 300_000) {
      return reply.code(401).send({ error: "timestamp quá hạn" });
    }
    const secret = decryptSecret(wh.secretEncrypted);
    const rawBody = JSON.stringify(req.body ?? {});
    const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
    const ok =
      sig.length === expected.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return reply.code(401).send({ error: "chữ ký sai" });

    const ctx: WorkspaceContext = { workspaceId: wh.workspaceId, userId: wh.workspaceId, role: "operator" };
    if (!(await consumeNonce(db, ctx, wh.id, nonce))) {
      return reply.code(409).send({ error: "nonce đã dùng (replay)" });
    }

    const agent = await getAgentById(db, ctx, wh.agentId);
    if (!agent) return reply.code(404).send({ error: "agent không tồn tại" });
    const message = String((req.body as { message?: string })?.message ?? "");
    if (!message) return reply.code(400).send({ error: "thiếu message" });

    // chạy nền, trả 202
    void (async () => {
      try {
        const session = await createSession(db, ctx, { agentId: agent.id, title: "webhook" });
        const loopDeps = await buildLoopDeps(deps, ctx, agent.provider, {
          ...agentOpts(agent),
          sourceKind: "webhook",
          accessRole: null,
        });
        const res = await runAgentText(loopDeps, {
          ctx,
          agent: { systemPrompt: agent.systemPrompt, model: agent.model, maxIterations: agent.maxIterations },
          sessionId: session.id,
          userMessage: message,
        });
        recordTraceSafe(db, ctx, {
          agentId: agent.id,
          sessionId: session.id,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          iterations: res.iterations,
          durationMs: res.durationMs,
          source: "webhook",
          model: agent.model,
          provider: agent.provider,
          kind: "webhook",
        });
      } catch {
        // ignore
      }
    })();
    return reply.code(202).send({ accepted: true });
  });

  // Microsoft Teams (Azure Bot): MỘT messaging endpoint cho mọi kênh msteams —
  // Azure trỏ https://<domain>/webhooks/teams; route tự tìm kênh theo App ID
  // trong recipient của activity. Public nhưng verify JWT Bot Framework fail-closed.
  // Bot Framework RETRY giao lại activity quanh lúc server restart/chậm →
  // dedupe theo activity.id (không dedupe thì 1 tin chạy agent 2-3 lần).
  const seenTeamsActivities = new Map<string, number>();
  const isDuplicateTeamsActivity = (id: string | undefined): boolean => {
    if (!id) return false;
    const now = Date.now();
    if (seenTeamsActivities.has(id)) return true;
    seenTeamsActivities.set(id, now);
    if (seenTeamsActivities.size > 500) {
      for (const [k, t] of seenTeamsActivities) {
        if (now - t > 10 * 60_000) seenTeamsActivities.delete(k);
      }
    }
    return false;
  };
  app.post("/webhooks/teams", async (req, reply) => {
    const activity = (req.body ?? {}) as {
      recipient?: { id?: string };
      conversation?: { id?: string };
    };
    const entries = [...channelHandlers.values()].filter(
      (e): e is typeof e & { channel: TeamsChannel } => e.channel instanceof TeamsChannel,
    );
    if (!entries.length) return reply.code(404).send({ error: "Chưa có kênh msteams nào chạy" });
    const recipientId = String(activity.recipient?.id ?? "");
    const entry =
      entries.find((e) => recipientId.includes(e.channel.appId)) ??
      (entries.length === 1 ? entries[0]! : undefined);
    if (!entry) return reply.code(404).send({ error: "Không khớp kênh msteams nào" });
    const teams = entry.channel;
    if (!(await verifyTeamsJwt(req.headers.authorization, teams.appId, teams.tenantId))) {
      return reply.code(401).send({ error: "JWT Bot Framework không hợp lệ" });
    }
    if (isDuplicateTeamsActivity((req.body as { id?: string })?.id)) {
      return reply.send({});
    }
    teams.noteActivity(req.body as Parameters<TeamsChannel["noteActivity"]>[0]);
    // Bấm nút Adaptive Card (thẻ duyệt...) → chuỗi callback handler chung
    const cardCb = parseTeamsCardAction(teams.id, req.body as Parameters<typeof parseTeamsCardAction>[1]);
    if (cardCb) {
      void dispatchChannelCallback(cardCb).catch((err) =>
        logger.warn(`Teams card callback lỗi: ${(err as Error).message}`),
      );
      return reply.send({});
    }
    const msg = parseTeamsActivity(teams.id, req.body as Parameters<typeof parseTeamsActivity>[1]);
    if (msg) {
      // Xử lý nền — Bot Framework chỉ chờ ~15s cho HTTP response
      void (async () => {
        // Tải ảnh/file đính kèm về trước khi chạy agent (lưu vào workspace)
        try {
          const media = await teams.extractMedia(
            req.body as Parameters<TeamsChannel["extractMedia"]>[0],
          );
          if (media.length) msg.media = media;
        } catch (err) {
          logger.warn(`Teams extractMedia lỗi: ${(err as Error).message}`);
        }
        // Typing keepalive: chấm "đang soạn" tự tắt sau vài giây trên Teams —
        // lặp lại mỗi 7s suốt lượt chạy (model thinking có thể >1 phút).
        void teams.postTyping(msg.chatKey).catch(() => {});
        const typingTimer = setInterval(() => {
          void teams.postTyping(msg.chatKey).catch(() => {});
        }, 7000);
        typingTimer.unref?.();
        // Streaming chính thức của Teams chỉ hỗ trợ chat 1-1
        const stream = msg.peerKind === "direct" ? teams.createStream(msg.chatKey) : null;
        let deltas = 0;
        try {
          const res = await entry.handler(
            msg,
            stream
              ? {
                  onTextDelta: (d) => {
                    deltas += 1;
                    stream.push(d);
                  },
                }
              : undefined,
          );
          // Dừng keepalive TRƯỚC khi gửi tin cuối — typing bắn sau tin nhắn
          // cuối làm indicator treo thêm chục giây (đến khi Teams tự hết hạn).
          clearInterval(typingTimer);
          if (res.kind === "reply" || res.kind === "pairing") {
            const streamed = stream ? await stream.finish(res.text) : false;
            logger.info(
              `Teams run xong: peer=${msg.peerKind}, deltas=${deltas}, streamed=${streamed}`,
            );
            if (!streamed) {
              stream?.abort();
              await entry.channel.send({ chatKey: msg.chatKey, text: res.text });
            }
            // File/ảnh agent tạo ra (send_file): Teams không cho bot upload file
            // trực tiếp → publish link công khai có hạn (7 ngày, thu hồi được);
            // ảnh gửi dạng attachment hiển thị inline.
            if (res.kind === "reply" && res.media?.length) {
              try {
                const publicBase = (process.env.PENAI_PUBLIC_URL ?? "").replace(/\/$/, "");
                const dataRoot = resolve(deps.config.dataDir);
                const wsCtx: WorkspaceContext = {
                  workspaceId: entry.workspaceId,
                  userId: entry.workspaceId,
                  role: "ws_admin",
                };
                const items: Array<{ name: string; url: string; contentType: string }> = [];
                for (const p of res.media.slice(0, 5)) {
                  if (!publicBase) break;
                  const abs = resolve(p);
                  if (abs !== dataRoot && !abs.startsWith(dataRoot + sep)) continue;
                  try {
                    await assertRealPathInside(abs, [dataRoot], "vùng dữ liệu");
                  } catch {
                    continue;
                  }
                  const token = randomBytes(32).toString("base64url");
                  const name = basename(abs);
                  await createPublishedFile(db, wsCtx, {
                    tokenHash: createHash("sha256").update(token).digest("hex"),
                    absPath: abs,
                    fileName: name,
                    contentType: contentTypeOf(name),
                    createdBy: `msteams-${msg.senderId}`,
                    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
                  });
                  items.push({ name, url: `${publicBase}/f/${token}`, contentType: contentTypeOf(name) });
                }
                if (items.length) await teams.sendMedia(msg.chatKey, items);
              } catch (err) {
                logger.warn(`Teams gửi media lỗi: ${(err as Error).message}`);
              }
            }
          } else {
            stream?.abort();
          }
        } catch (err) {
          stream?.abort();
          logger.warn(`Teams inbound xử lý lỗi: ${(err as Error).message}`);
        } finally {
          clearInterval(typingTimer);
        }
      })();
    }
    return reply.send({});
  });

  app.post("/webhooks/whatsapp/:channelId", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const entry = channelHandlers.get(channelId);
    if (!entry) return reply.code(404).send({ error: "channel không chạy" });
    const msgs = parseWhatsappWebhook(channelId, req.body);
    // Xử lý nền, trả 200 ngay (Meta yêu cầu phản hồi nhanh)
    void (async () => {
      for (const m of msgs) {
        try {
          const res = await entry.handler(m);
          if (res.kind === "reply" || res.kind === "pairing") {
            await entry.channel.send({ chatKey: m.chatKey, text: res.text });
          }
        } catch {
          // log ở onError
        }
      }
    })();
    return reply.send({ ok: true });
  });

  // ===== Agents =====
  app.get("/v1/agents", async (req) => {
    const agents = await listAgents(db, req.authCtx);
    if (req.authCtx.role === "member") {
      // member không được xem system prompt / cấu hình — chỉ đủ để chọn agent chat
      return {
        agents: agents.map((a) => ({
          id: a.id,
          key: a.key,
          name: a.name,
          provider: a.provider,
          model: a.model,
        })),
      };
    }
    return { agents };
  });

  app.post("/v1/agents", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = CreateAgentBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    const agent = await createAgent(db, req.authCtx, parsed.data);
    return reply.code(201).send({ agent });
  });

  app.patch("/v1/agents/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const parsed = UpdateAgentBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    if (parsed.data.browserProfileId && !(await getBrowserProfile(db, req.authCtx, parsed.data.browserProfileId))) {
      return reply.code(400).send({ error: "Hồ sơ trình duyệt không tồn tại" });
    }
    const before = parsed.data.libraryWritable === undefined ? null : await getAgentById(db, req.authCtx, id);
    const agent = await updateAgent(db, req.authCtx, id, parsed.data);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    // Ai đổi gì, lúc nào (26/09/2026: đổi Thinking làm agent lỗi mà không tra lại được).
    // Nội dung prompt không ghi — chỉ tên trường + giá trị ngắn của provider/model/thinking.
    await recordAudit(db, req.authCtx, "agent.update", {
      agentId: agent.id,
      agentKey: agent.key,
      fields: Object.keys(parsed.data),
      ...(parsed.data.provider !== undefined ? { provider: agent.provider } : {}),
      ...(parsed.data.model !== undefined ? { model: agent.model } : {}),
      ...(parsed.data.thinkingLevel !== undefined ? { thinkingLevel: agent.thinkingLevel } : {}),
    });
    // Quyền ghi thư viện là thiết lập an toàn → ghi nhật ký khi đổi
    if (before && before.libraryWritable !== agent.libraryWritable) {
      await recordAudit(db, req.authCtx, "library.agent_write_toggle", {
        agentId: agent.id,
        agentKey: agent.key,
        writable: agent.libraryWritable,
      });
    }
    return { agent };
  });

  app.delete("/v1/agents/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    // channels.agent_id cố ý RESTRICT (kênh phải có agent trả lời) → báo rõ thay vì 500.
    const usingChannels = (await listChannels(db, req.authCtx)).filter((c) => c.agentId === id);
    if (usingChannels.length > 0) {
      return reply.code(409).send({
        error: `Agent đang là agent trả lời của kênh: ${usingChannels
          .map((c) => c.name)
          .join(", ")}. Đổi agent của kênh (hoặc xóa kênh) trước rồi xóa agent.`,
      });
    }
    const ok = await deleteAgent(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Agent không tồn tại" });
    return { deleted: true };
  });

  // ===== Providers & models & tools (cho UI) =====
  const listProviderModels = async (
    provider:
      | CodexProvider
      | AnthropicProvider
      | OpenAICompatProvider
      | AntigravityProvider
      | ClaudeCodeProvider,
  ) => {
    return provider.listModels();
  };

  const makeApiKeyProvider = (
    name: string,
    credential: { kind: z.infer<typeof ProviderKindSchema>; apiKey: string; baseUrl?: string | null },
  ) => {
    const baseUrl = normalizedProviderBaseUrl(credential.kind, credential.baseUrl);
    if (credential.kind === "gemini") {
      return new GeminiProvider(name, { apiKey: credential.apiKey });
    }
    if (credential.kind === "qwen") {
      return new QwenProvider(name, {
        apiKey: credential.apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
    }
    if (credential.kind === "anthropic") {
      return new AnthropicProvider(name, {
        apiKey: credential.apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
    }
    return new OpenAICompatProvider(name, {
      apiKey: credential.apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  };

  const inspectApiKeyProvider = async (
    credential: {
      kind: z.infer<typeof ProviderKindSchema>;
      apiKey: string;
      baseUrl?: string | null;
      chatModel?: string | null;
      embeddingModel?: string | null;
      embeddingDimensions?: number | null;
    },
    runModelTests: boolean,
  ) => {
    const provider = makeApiKeyProvider("credential-check", credential);
    const chatModels = await listProviderModels(provider);
    const embeddingModels = isEmbeddingProvider(provider)
      ? await provider.listEmbeddingModels()
      : [];
    if (runModelTests && credential.chatModel) {
      const result = await provider.chat({
        model: credential.chatModel,
        system: "Return only OK.",
        messages: [{ role: "user", content: "Connection test" }],
        maxTokens: 128,
      });
      if (!result.content?.trim() && result.toolCalls.length === 0) {
        throw new Error("Model chat không trả nội dung khi kiểm tra");
      }
    }
    if (runModelTests && credential.embeddingModel) {
      if (!isEmbeddingProvider(provider)) throw new Error("Provider không hỗ trợ embedding");
      const result = await provider.embed({
        model: credential.embeddingModel,
        inputs: ["PenAI connection test"],
        ...(credential.embeddingDimensions
          ? { dimensions: credential.embeddingDimensions }
          : {}),
        inputType: "document",
      });
      const vector = result.vectors[0];
      if (!vector?.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("Model embedding không trả vector hợp lệ");
      }
      if (credential.embeddingDimensions && vector.length !== credential.embeddingDimensions) {
        throw new Error(
          `Model embedding trả ${vector.length} chiều, khác cấu hình ${credential.embeddingDimensions}`,
        );
      }
    }
    return { provider, chatModels, embeddingModels };
  };

  app.get("/v1/providers", async (req) => {
    const dbRows = await listLlmProviders(db, req.authCtx);
    const dbByName = new Map(dbRows.map((row) => [row.name, row]));
    // Antigravity: xác thực bằng CLI — kiểm tra (có cache 60s) trước khi render trạng thái.
    for (const name of deps.providers.names(req.authCtx.workspaceId)) {
      try {
        const p = deps.providers.get(name, req.authCtx.workspaceId);
        if (p instanceof AntigravityProvider && p.cliInstalled()) await p.checkAuth();
      } catch {
        /* provider lỗi cấu hình — bỏ qua, hiển thị mặc định */
      }
    }
    const list = deps.providers.names(req.authCtx.workspaceId).map((name) => {
      const p = deps.providers.get(name, req.authCtx.workspaceId);
      const info: {
        name: string;
        kind: string;
        loggedIn?: boolean;
        /** Chỉ provider chạy qua CLI (claude-code, antigravity): đã cài file chạy chưa. */
        cliInstalled?: boolean;
        email?: string;
        accounts?: Array<{
          alias: string;
          email?: string;
          status: string;
          cooldownSeconds?: number;
          inFlight: number;
        }>;
        defaultModel?: string;
        defaultEmbeddingModel?: string;
        embeddingDimensions?: number;
        supportsEmbedding?: boolean;
      } = {
        name,
        kind:
          p instanceof CodexProvider
            ? "codex"
            : p instanceof AntigravityProvider
              ? "antigravity"
              : p instanceof ClaudeCodeProvider
                ? "claude-code"
                : "llm",
      };
      if (p instanceof AntigravityProvider || p instanceof ClaudeCodeProvider) {
        info.cliInstalled = p.cliInstalled();
        // antigravity: checkAuth chạy trước map; chưa cài CLI thì chắc chắn chưa dùng được
        info.loggedIn = info.cliInstalled && p.status().state === "ok";
      }
      const dbRow = dbByName.get(name);
      if (dbRow?.defaultModel) info.defaultModel = dbRow.defaultModel;
      if (dbRow?.defaultEmbeddingModel) info.defaultEmbeddingModel = dbRow.defaultEmbeddingModel;
      if (dbRow?.embeddingDimensions) info.embeddingDimensions = dbRow.embeddingDimensions;
      info.supportsEmbedding = isEmbeddingProvider(p);
      if (p instanceof CodexProvider) {
        const accounts = p.listAccounts();
        info.loggedIn = accounts.length > 0;
        if (accounts[0]?.email) info.email = accounts[0].email;
        info.accounts = accounts.map((a) => ({
          alias: a.alias,
          ...(a.email ? { email: a.email } : {}),
          status: a.status,
          ...(a.cooldownSeconds !== undefined ? { cooldownSeconds: a.cooldownSeconds } : {}),
          inFlight: a.inFlight,
        }));
      }
      return info;
    });
    return { providers: list };
  });

  app.get("/v1/providers/:name/models", async (req, reply) => {
    const { name } = req.params as { name: string };
    let provider;
    try {
      provider = deps.providers.get(name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (
      provider instanceof OpenAICompatProvider ||
      provider instanceof AnthropicProvider ||
      provider instanceof CodexProvider ||
      provider instanceof AntigravityProvider ||
      provider instanceof ClaudeCodeProvider
    ) {
      try {
        const dbRow = (await listLlmProviders(db, req.authCtx)).find((row) => row.name === name);
        return { models: await listProviderModels(provider), defaultModel: dbRow?.defaultModel ?? null };
      } catch (err) {
        return reply.code(502).send({ error: providerErrorMessage(err) });
      }
    }
    return { models: [] };
  });

  app.get("/v1/providers/:name/embedding-models", async (req, reply) => {
    const { name } = req.params as { name: string };
    let provider;
    try {
      provider = deps.providers.get(name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (!isEmbeddingProvider(provider)) {
      return { models: [], defaultModel: null, dimensions: null };
    }
    try {
      const dbRow = (await listLlmProviders(db, req.authCtx)).find((row) => row.name === name);
      return {
        models: await provider.listEmbeddingModels(),
        defaultModel: dbRow?.defaultEmbeddingModel ?? null,
        dimensions: dbRow?.embeddingDimensions ?? null,
      };
    } catch (err) {
      return reply.code(502).send({ error: providerErrorMessage(err) });
    }
  });

  // Kiểm tra credential và tải model trước khi lưu provider, giúp form báo lỗi rõ ràng.
  app.post("/v1/providers/preview-models", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = ProviderCredentialBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const b = parsed.data;
    try {
      const inspected = await inspectApiKeyProvider(
        {
          ...b,
          ...(b.chatModel ? { chatModel: b.chatModel } : {}),
          ...(b.embeddingModel ? { embeddingModel: b.embeddingModel } : {}),
        },
        Boolean(b.chatModel || b.embeddingModel),
      );
      return {
        verified: true,
        models: inspected.chatModels,
        embeddingModels: inspected.embeddingModels,
        tested: {
          chat: Boolean(b.chatModel),
          embedding: Boolean(b.embeddingModel),
        },
      };
    } catch (err) {
      return reply.code(400).send({ error: providerErrorMessage(err) });
    }
  });

  // ===== Providers DB (tạo runtime từ dashboard, hot-register không cần restart) =====
  app.get("/v1/providers-db", async (req) => {
    const rows = await listLlmProviders(db, req.authCtx);
    // không trả api key
    return {
      providers: rows.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        defaultEmbeddingModel: p.defaultEmbeddingModel,
        embeddingDimensions: p.embeddingDimensions,
        isDefaultEmbedding: p.isDefaultEmbedding,
        enabled: p.enabled,
        hasKey: Boolean(p.apiKeyEncrypted),
      })),
    };
  });

  app.post("/v1/providers-db", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = CreateProviderBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    const b = parsed.data;
    let baseUrl: string | undefined;
    try {
      baseUrl = normalizedProviderBaseUrl(b.kind, b.baseUrl);
      await inspectApiKeyProvider(
        {
          kind: b.kind,
          apiKey: b.apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          ...(b.defaultModel ? { chatModel: b.defaultModel } : {}),
          ...(b.defaultEmbeddingModel ? { embeddingModel: b.defaultEmbeddingModel } : {}),
          ...(b.embeddingDimensions ? { embeddingDimensions: b.embeddingDimensions } : {}),
        },
        true,
      );
    } catch (err) {
      return reply.code(400).send({ error: providerErrorMessage(err) });
    }
    let row;
    try {
      row = await createLlmProvider(db, req.authCtx, {
        name: b.name,
        kind: b.kind,
        ...(baseUrl ? { baseUrl } : {}),
        apiKeyEncrypted: encryptSecret(b.apiKey),
        ...(b.defaultModel ? { defaultModel: b.defaultModel } : {}),
        ...(b.defaultEmbeddingModel
          ? { defaultEmbeddingModel: b.defaultEmbeddingModel }
          : {}),
        ...(b.embeddingDimensions ? { embeddingDimensions: b.embeddingDimensions } : {}),
        ...(b.isDefaultEmbedding ? { isDefaultEmbedding: true } : {}),
      });
    } catch (err) {
      if (databaseErrorCode(err) === "23505") {
        return reply.code(409).send({ error: `Tên provider "${b.name}" đã tồn tại` });
      }
      throw err;
    }
    // hot-register ngay — không cần restart
    registerDbProvider(deps.providers, {
      name: b.name,
      workspaceId: req.authCtx.workspaceId,
      kind: b.kind,
      baseUrl: baseUrl ?? null,
      apiKey: b.apiKey,
    });
    return reply.code(201).send({
      provider: { id: row.id, name: row.name, kind: row.kind },
    });
  });

  app.patch("/v1/providers-db/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = UpdateProviderBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const { id } = req.params as { id: string };
    const row = (await listLlmProviders(db, req.authCtx)).find((provider) => provider.id === id);
    if (!row) return reply.code(404).send({ error: "Provider không tồn tại" });
    const body = parsed.data;
    let apiKey: string;
    try {
      apiKey = body.apiKey ?? (row.apiKeyEncrypted ? decryptSecret(row.apiKeyEncrypted) : "");
      if (!apiKey) throw new Error("Provider chưa có API key");
      const baseUrl = normalizedProviderBaseUrl(row.kind as z.infer<typeof ProviderKindSchema>, body.baseUrl ?? row.baseUrl);
      const defaultModel = body.defaultModel === undefined ? row.defaultModel : body.defaultModel;
      const defaultEmbeddingModel =
        body.defaultEmbeddingModel === undefined
          ? row.defaultEmbeddingModel
          : body.defaultEmbeddingModel;
      const embeddingDimensions =
        body.embeddingDimensions === undefined
          ? row.embeddingDimensions
          : body.embeddingDimensions;
      await inspectApiKeyProvider(
        {
          kind: row.kind as z.infer<typeof ProviderKindSchema>,
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          ...(defaultModel ? { chatModel: defaultModel } : {}),
          ...(defaultEmbeddingModel ? { embeddingModel: defaultEmbeddingModel } : {}),
          ...(embeddingDimensions ? { embeddingDimensions } : {}),
        },
        true,
      );
      await updateLlmProvider(db, req.authCtx, id, {
        ...(body.apiKey ? { apiKeyEncrypted: encryptSecret(body.apiKey) } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: baseUrl ?? null } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(body.defaultEmbeddingModel !== undefined
          ? { defaultEmbeddingModel: body.defaultEmbeddingModel }
          : {}),
        ...(body.embeddingDimensions !== undefined
          ? { embeddingDimensions: body.embeddingDimensions }
          : {}),
        ...(body.isDefaultEmbedding !== undefined
          ? { isDefaultEmbedding: body.isDefaultEmbedding }
          : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      });
      if (body.enabled === false) {
        deps.providers.removeRuntime(req.authCtx.workspaceId, row.name);
      } else {
        registerDbProvider(deps.providers, {
          workspaceId: req.authCtx.workspaceId,
          name: row.name,
          kind: row.kind,
          baseUrl: baseUrl ?? null,
          apiKey,
        });
      }
      return { updated: true };
    } catch (err) {
      return reply.code(400).send({ error: providerErrorMessage(err) });
    }
  });

  app.delete("/v1/providers-db/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const rows = await listLlmProviders(db, req.authCtx);
    const row = rows.find((p) => p.id === id);
    if (!row) return reply.code(404).send({ error: "Provider không tồn tại" });
    const usedByAgents = await countAgentsUsingProvider(db, req.authCtx, row.name);
    if (usedByAgents > 0) {
      return reply.code(409).send({ error: `Provider đang được ${usedByAgents} agent/fallback sử dụng` });
    }
    if (row.isDefaultEmbedding) {
      return reply.code(409).send({ error: "Provider đang là embedding mặc định; hãy đổi provider mặc định trước" });
    }
    await deleteLlmProvider(db, req.authCtx, id);
    deps.providers.removeRuntime(req.authCtx.workspaceId, row.name);
    return { deleted: true };
  });

  app.post("/v1/embeddings", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const parsed = EmbeddingBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data;
    const rows = await listLlmProviders(db, req.authCtx);
    const row = body.provider
      ? rows.find((provider) => provider.name === body.provider && provider.enabled)
      : rows.find((provider) => provider.isDefaultEmbedding && provider.enabled);
    if (!row) {
      return reply.code(404).send({
        error: body.provider
          ? "Provider embedding không tồn tại hoặc đang tắt"
          : "Workspace chưa chọn provider embedding mặc định",
      });
    }
    let provider;
    try {
      provider = deps.providers.get(row.name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (!isEmbeddingProvider(provider)) {
      return reply.code(400).send({ error: "Provider này không hỗ trợ embedding" });
    }
    const model = body.model ?? row.defaultEmbeddingModel;
    if (!model) return reply.code(400).send({ error: "Chưa chọn model embedding" });
    try {
      const result = await provider.embed({
        model,
        inputs: body.inputs,
        ...(body.dimensions ?? row.embeddingDimensions
          ? { dimensions: body.dimensions ?? row.embeddingDimensions ?? undefined }
          : {}),
        ...(body.inputType ? { inputType: body.inputType } : {}),
        ...(body.title ? { title: body.title } : {}),
      });
      return result;
    } catch (err) {
      return reply.code(502).send({ error: providerErrorMessage(err) });
    }
  });

  app.get("/v1/tools", async () => {
    return {
      tools: deps.tools.list().map((t) => ({
        name: t.name,
        description: t.description,
      })),
    };
  });

  // ===== Channels =====
  app.get("/v1/channels", async (req) => {
    const [rows, agents] = await Promise.all([
      listChannels(db, req.authCtx),
      listAgents(db, req.authCtx),
    ]);
    const agentById = new Map(agents.map((a) => [a.id, a]));
    // Không trả token
    return {
      channels: rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        agentId: c.agentId,
        agentKey: agentById.get(c.agentId)?.key ?? null,
        agentName: agentById.get(c.agentId)?.name ?? null,
        enabled: c.enabled,
        requirePairing: c.requirePairing,
        // config không chứa secret (secret nằm ở token_encrypted) — UI cần để sửa
        config: c.config ?? {},
      })),
      supportedKinds: supportedChannelKinds(),
    };
  });

  /** ChannelRow → shape EnabledChannel cho runtime khởi động lại. */
  const toEnabledChannel = (c: {
    id: string;
    workspaceId: string;
    kind: string;
    name: string;
    agentId: string;
    tokenEncrypted: string | null;
    config: unknown;
    requirePairing: boolean;
  }) => ({
    id: c.id,
    workspaceId: c.workspaceId,
    kind: c.kind,
    name: c.name,
    agentId: c.agentId,
    tokenEncrypted: c.tokenEncrypted,
    config: (c.config as Record<string, unknown>) ?? {},
    requirePairing: c.requirePairing,
  });

  app.post("/v1/channels", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = CreateChannelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    const body = parsed.data;
    if (!isChannelKindSupported(body.kind)) {
      return reply
        .code(400)
        .send({ error: `Kind chưa hỗ trợ. Có: ${supportedChannelKinds().join(", ")}` });
    }
    if (body.kind !== "zalo_personal" && !body.token.trim()) {
      return reply.code(400).send({ error: "Channel này cần token / credential" });
    }
    if (body.kind === "msteams" && !String(body.config?.["appId"] ?? "").trim()) {
      return reply.code(400).send({ error: "Kênh Teams cần Microsoft App ID (config.appId)" });
    }
    const agent = await getAgentByKey(db, req.authCtx, body.agentKey);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const channel = await createChannel(db, req.authCtx, {
      kind: body.kind,
      name: body.name,
      agentId: agent.id,
      tokenEncrypted: encryptSecret(body.token || "{}"),
      requirePairing: body.requirePairing,
      ...(body.config ? { config: body.config } : {}),
    });
    const note = await applyChannelChange(channel.id, toEnabledChannel(channel));
    return reply.code(201).send({
      channel: { id: channel.id, kind: channel.kind, name: channel.name },
      note,
    });
  });

  // Sửa channel: tên, agent gắn kèm, token (bỏ trống = giữ), pairing, bật/tắt.
  // Áp dụng NGAY (dừng + khởi động lại channel đó), không cần restart server.
  app.patch("/v1/channels/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const parsed = UpdateChannelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    const b = parsed.data;
    const existing = await getChannelById(db, req.authCtx, id);
    if (!existing) return reply.code(404).send({ error: "Channel không tồn tại" });
    let agentId: string | undefined;
    if (b.agentKey) {
      const agent = await getAgentByKey(db, req.authCtx, b.agentKey);
      if (!agent) return reply.code(404).send({ error: `Agent "${b.agentKey}" không tồn tại` });
      agentId = agent.id;
    }
    const updated = await updateChannel(db, req.authCtx, id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(agentId ? { agentId } : {}),
      ...(b.token ? { tokenEncrypted: encryptSecret(b.token) } : {}),
      ...(b.requirePairing !== undefined ? { requirePairing: b.requirePairing } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      ...(b.config !== undefined ? { config: { ...(existing.config as Record<string, unknown>), ...b.config } } : {}),
    });
    if (!updated) return reply.code(404).send({ error: "Channel không tồn tại" });
    const note = await applyChannelChange(
      id,
      updated.enabled ? toEnabledChannel(updated) : null,
    );
    return {
      channel: {
        id: updated.id,
        kind: updated.kind,
        name: updated.name,
        agentId: updated.agentId,
        enabled: updated.enabled,
        requirePairing: updated.requirePairing,
      },
      note,
    };
  });

  app.delete("/v1/channels/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteChannel(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Channel không tồn tại" });
    await applyChannelChange(id, null).catch(() => {});
    return { deleted: true };
  });

  // Tên hiển thị cho danh sách pairing: contacts (mọi kênh) + fallback
  // zalo_observed_peers (kênh zalo_personal — tên người gửi đã quan sát).
  const pairingDisplayNames = async (
    ctx: FastifyRequest["authCtx"],
    channels: Array<{ id: string; kind: string }>,
  ): Promise<(kind: string, channelId: string, externalId: string | null) => string | null> => {
    const contactRows = await listContacts(db, ctx);
    const byKindId = new Map<string, string>();
    for (const c of contactRows) {
      if (c.displayName) byKindId.set(`${c.channelKind}:${c.externalId}`, c.displayName);
    }
    const zaloByChannelSender = new Map<string, string>();
    await Promise.all(
      channels
        .filter((c) => c.kind === "zalo_personal")
        .map(async (c) => {
          for (const row of await listZaloObservedPeers(db, ctx, c.id)) {
            zaloByChannelSender.set(`${c.id}:${row.lastSenderId}`, row.lastSenderName);
            if (row.kind === "direct") zaloByChannelSender.set(`${c.id}:${row.threadId}`, row.name);
          }
        }),
    );
    return (kind, channelId, externalId) => {
      if (!externalId) return null;
      return (
        byKindId.get(`${kind}:${externalId}`) ??
        zaloByChannelSender.get(`${channelId}:${externalId}`) ??
        null
      );
    };
  };

  app.get("/v1/channel-pairings/pending", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const [rows, channelRows] = await Promise.all([
      listPendingPairings(db, req.authCtx),
      listChannels(db, req.authCtx),
    ]);
    const channelById = new Map(channelRows.map((channel) => [channel.id, channel]));
    const nameOf = await pairingDisplayNames(req.authCtx, channelRows);
    return {
      pending: rows.flatMap((pairing) => {
        const channel = channelById.get(pairing.channelId);
        if (!channel) return [];
        return [{
          channelId: pairing.channelId,
          channelName: channel.name,
          channelKind: channel.kind,
          code: pairing.code,
          externalUserId: pairing.externalUserId,
          displayName: nameOf(channel.kind, channel.id, pairing.externalUserId),
          createdAt: pairing.createdAt,
          expiresAt: pairing.expiresAt,
        }];
      }),
    };
  });

  app.get("/v1/channels/:id/pairings", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const [rows, row] = await Promise.all([
      listPendingPairings(db, req.authCtx),
      getChannelById(db, req.authCtx, id),
    ]);
    if (!row) return reply.code(404).send({ error: "Channel không tồn tại" });
    const nameOf = await pairingDisplayNames(req.authCtx, [{ id, kind: row.kind }]);
    return {
      pending: rows
        .filter((p) => p.channelId === id)
        .map((p) => ({
          code: p.code,
          externalUserId: p.externalUserId,
          displayName: nameOf(row.kind, id, p.externalUserId),
          createdAt: p.createdAt,
        })),
    };
  });

  app.post("/v1/channels/:id/pairings/:code/approve", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id, code } = req.params as { id: string; code: string };
    const approved = await approvePairing(db, req.authCtx, id, code);
    if (!approved) return reply.code(404).send({ error: "Mã pairing không hợp lệ hoặc đã duyệt" });
    // Tin chào mừng do CHÍNH AGENT của kênh tự soạn (mỗi bot một vai) — chạy
    // nền để duyệt trả về ngay; lỗi ở bước nào thì fallback câu chào chung.
    const ctx = req.authCtx;
    if (approved.externalUserId) {
      const chatKey = approved.externalUserId;
      void (async () => {
        const runtime = channelHandlers.get(id)?.channel;
        if (!runtime?.isRunning()) return;
        const fallback =
          "✅ Bạn đã được duyệt! Hãy nhắn câu hỏi hoặc việc cần làm — có thể gửi " +
          "kèm ảnh/tài liệu (thêm caption để tôi lưu file đúng tên). Gõ /help để xem lệnh.";
        let text = fallback;
        try {
          const row = await getChannelById(db, ctx, id);
          const agent = row ? await getAgentById(db, ctx, row.agentId) : null;
          if (agent) {
            // Gắn vào đúng session hội thoại của chat này để agent "nhớ" đã chào
            let sessionId = await getChannelSession(db, ctx, id, chatKey);
            if (!sessionId) {
              const s = await createSession(db, ctx, { agentId: agent.id, title: `${row!.kind}:${chatKey}` });
              await mapChannelSession(db, ctx, id, chatKey, s.id);
              sessionId = s.id;
            }
            // Contact đã có từ lúc người này nhắn lần đầu (trước cổng duyệt) → lời
            // chào dùng được hồ sơ/cách xưng hô quản trị viên đặt sẵn.
            const identity = await findContactIdentity(db, ctx, id, chatKey).catch(() => null);
            const loopDeps = await buildLoopDeps(deps, ctx, agent.provider, {
              ...agentOpts(agent),
              userKey: `${row!.kind}-${chatKey}`,
              ...(identity
                ? { principalId: identity.principalId, channelIdentityId: identity.contactId }
                : {}),
              person: { channelKind: row!.kind, peerKind: "direct" },
              sourceKind: "channel",
              accessRole: null,
            });
            const effort = reasoningEffortOf(agent);
            // PHẢI xếp vào hàng đợi session của channels (không phải queue của
            // app) — nếu không, lượt chào mừng và tin nhắn đầu của người dùng
            // chạy song song → 2 tin chào gần trùng (lộ rõ với provider chậm).
            const generated = await scheduleOnChannelQueue(sessionId, () =>
              runAgentText(loopDeps, {
                ctx,
                agent: {
                  systemPrompt: agent.systemPrompt,
                  model: agent.model,
                  maxIterations: agent.maxIterations,
                  ...(effort ? { reasoningEffort: effort } : {}),
                },
                sessionId,
                userMessage:
                  "Hệ thống: người dùng này VỪA ĐƯỢC quản trị viên duyệt vào kênh chat. " +
                  "Hãy gửi lời chào mừng đầu tiên: xác nhận họ đã được duyệt, giới thiệu ngắn gọn " +
                  "bạn tên gì / vai trò gì / giúp được những việc gì (2-4 dòng), mời họ đặt câu hỏi " +
                  "hoặc gửi ảnh/tài liệu kèm caption. Không dùng tool trong lượt này. " +
                  "(Chỉ chào mừng DUY NHẤT lượt này — các lượt sau kể cả khi người dùng chào lại, " +
                  "trả lời tự nhiên ngắn gọn, TUYỆT ĐỐI không lặp lại lời giới thiệu này.)",
              }),
            );
            if (generated?.text?.trim()) text = generated.text.trim();
          }
        } catch (err) {
          logger.warn(`Không sinh được lời chào pairing (dùng fallback): ${(err as Error).message}`);
        }
        try {
          await runtime.send({ chatKey, text });
        } catch (err) {
          logger.warn(`Không gửi được tin chào mừng pairing: ${(err as Error).message}`);
        }
      })();
    }
    return { approved: true };
  });

  // ===== Zalo Personal (zca-js, unofficial): trạng thái + đăng nhập QR =====
  const getZaloPersonalRuntime = async (
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
  ): Promise<ZaloPersonalChannel | null> => {
    const row = await getChannelById(db, req.authCtx, id);
    if (!row) {
      void reply.code(404).send({ error: "Channel không tồn tại" });
      return null;
    }
    if (row.kind !== "zalo_personal") {
      void reply.code(400).send({ error: "Channel này không phải Zalo Personal" });
      return null;
    }
    const runtime = channelHandlers.get(id)?.channel;
    if (!(runtime instanceof ZaloPersonalChannel)) {
      void reply.code(409).send({
        error: "Zalo Personal đang tạm dừng hoặc chưa khởi tạo. Hãy bật channel trước.",
      });
      return null;
    }
    return runtime;
  };

  app.get("/v1/channels/:id/zalo-personal/status", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    return { status: runtime.status() };
  });

  app.post("/v1/channels/:id/zalo-personal/login", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    const login = await runtime.startQrLogin();
    return { loginId: login.id };
  });

  app.get("/v1/channels/:id/zalo-personal/login/:loginId", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id, loginId } = req.params as { id: string; loginId: string };
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    const status = runtime.qrStatus(loginId);
    if (!status) return reply.code(404).send({ error: "Phiên QR không tồn tại hoặc đã hết hạn" });
    return { login: status };
  });

  app.post("/v1/channels/:id/zalo-personal/logout", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    await runtime.logout();
    return { disconnected: true };
  });

  app.get("/v1/channels/:id/zalo-personal/targets", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    return { targets: await runtime.listTargets() };
  });

  app.get("/v1/channels/:id/zalo-personal/resolve-phone", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const phone = String((req.query as { phone?: string }).phone ?? "").trim();
    if (!phone) return reply.code(400).send({ error: "Thiếu tham số phone" });
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    try {
      return await runtime.resolvePhone(phone);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post("/v1/channels/:id/zalo-personal/test-message", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const parsed = ZaloPersonalTestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    await runtime.sendTestMessage(
      parsed.data.threadId,
      parsed.data.peerKind,
      parsed.data.text,
    );
    return { sent: true };
  });

  // Chế độ an toàn Zalo: danh sách người/nhóm đã nhắn tới (metadata) và
  // allowlist thread demo. Ngoài allowlist: chỉ quan sát, không gửi/không chạy agent.
  app.get("/v1/channels/:id/zalo-personal/observed", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    // Danh sách chờ duyệt đọc từ DB (sống qua restart); RAM chỉ bù các tin
    // vừa đến chưa kịp ghi. Cờ `allowed` tính theo demo threads hiện tại.
    const demoThreads = runtime.demoThreads();
    const allowed = new Set(demoThreads);
    const byKey = new Map<
      string,
      ReturnType<typeof runtime.listObserved>[number]
    >();
    for (const row of await listZaloObservedPeers(db, req.authCtx, id)) {
      byKey.set(row.chatKey, {
        chatKey: row.chatKey,
        threadId: row.threadId,
        type: row.kind as "direct" | "group",
        name: row.name,
        lastSenderId: row.lastSenderId,
        lastSenderName: row.lastSenderName,
        messageCount: row.messageCount,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        allowed: allowed.has(row.chatKey),
      });
    }
    for (const peer of runtime.listObserved()) {
      const known = byKey.get(peer.chatKey);
      if (!known || peer.lastSeenAt > known.lastSeenAt) byKey.set(peer.chatKey, peer);
    }
    const peers = [...byKey.values()].sort((a, b) =>
      b.lastSeenAt.localeCompare(a.lastSeenAt),
    );
    const openDirect = runtime.status().openDirect;
    if (openDirect) {
      for (const p of peers) if (p.chatKey.startsWith("direct:")) p.allowed = true;
    }
    return { peers, demoThreads, openDirect };
  });

  app.put("/v1/channels/:id/zalo-personal/demo-threads", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const parsed = ZaloDemoThreadsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const runtime = await getZaloPersonalRuntime(req, reply, id);
    if (!runtime) return;
    const row = await getChannelById(db, req.authCtx, id);
    if (!row) return reply.code(404).send({ error: "Channel không tồn tại" });
    const config = {
      ...((row.config as Record<string, unknown>) ?? {}),
      demo_threads: parsed.data.threads,
    };
    await updateChannel(db, req.authCtx, id, { config });
    // Cập nhật nóng trên instance đang chạy — không restart, không đăng nhập lại
    runtime.setDemoThreads(parsed.data.threads);
    return { demoThreads: runtime.demoThreads() };
  });

  // ===== Contacts: hồ sơ, nhãn, chỉ dẫn cho AI theo từng người (0029) =====
  // Xem danh sách: mọi role (trừ member). Xem chi tiết + sửa hồ sơ/chỉ dẫn của
  // một người: operator trở lên. Nhãn có chỉ dẫn áp cho NHIỀU người → ws_admin.
  // Xuất Contacts ra Excel (.xlsx) — lọc theo kênh; kênh Zalo cá nhân kèm thêm sheet danh bạ Zalo đầy đủ.
  app.get("/v1/contacts/export.xlsx", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const q = req.query as { channelId?: string };
    const channelId = q.channelId && /^[0-9a-f-]{36}$/i.test(q.channelId) ? q.channelId : null;
    const allChannels = await listChannels(db, req.authCtx);
    const channel = channelId ? allChannels.find((c) => c.id === channelId) : null;
    if (channelId && !channel) return reply.code(404).send({ error: "Kênh không tồn tại" });
    const rows = await exportContacts(db, req.authCtx, channelId);
    const PAIR: Record<string, string> = {
      da_duyet: "Đã duyệt", cho_duyet: "Chờ duyệt", chua_duyet: "Chưa duyệt", khong_can: "Không cần duyệt", khong_ro: "Không rõ",
    };
    const kindLabel = (k: "direct" | "group" | null) => (k === "group" ? "Nhóm" : k === "direct" ? "Cá nhân" : "");
    const sheets = [
      {
        name: "Contacts",
        widths: [24, 16, 10, 22, 24, 24, 16, 16, 16, 22, 14, 16, 16, 24, 20, 28, 40, 14, 17, 17],
        rows: [
          ["Kênh", "Loại kênh", "Loại", "UID / ID", "Tên trên kênh", "Tên hồ sơ", "AI gọi là", "AI xưng", "SĐT (hồ sơ)",
            "SĐT (Zalo)", "Email", "Vai trò", "Ngôn ngữ", "Khóa người dùng", "Nhãn", "Trường tùy chỉnh", "Chỉ dẫn cho AI",
            "Duyệt", "Nhắn lần đầu", "Nhắn gần nhất"],
          ...rows.map((r): XlsxCell[] => [
            r.channelName, r.channelKind, kindLabel(r.peerKind), r.externalId, r.displayName, r.profileName, r.addressAs,
            r.selfAddress, r.phone, r.zaloPhone, r.email, r.roleTitle, r.language, r.userKey, r.tags, r.customFields,
            r.aiInstructions, r.peerKind === "group" ? "" : (PAIR[r.pairing] ?? r.pairing), r.firstSeen, r.lastSeen,
          ]),
        ],
      },
    ];
    const zaloChannels = allChannels.filter((c) => c.kind === "zalo_personal" && (!channelId || c.id === channelId));
    for (const zc of zaloChannels) {
      const threads = await listAllZaloThreads(db, req.authCtx, zc.id);
      sheets.push({
        name: `Danh bạ Zalo - ${zc.name}`,
        widths: [10, 22, 30, 16, 12, 12, 17, 10, 12],
        rows: [
          ["Loại", "UID / ID", "Tên", "SĐT", "Bạn bè / đang trong nhóm", "Số thành viên", "Tin gần nhất", "Chưa đọc", "AI"],
          ...threads.map((t): XlsxCell[] => [
            t.kind === "group" ? "Nhóm" : "Cá nhân", t.threadId, t.name, t.phone, t.isContact ? "Có" : "", t.memberCount ?? "",
            t.lastMessageAt ? new Date(t.lastMessageAt) : "", t.unreadCount || "", t.aiMode === "off" ? "Tắt" : "",
          ]),
        ],
      });
    }
    const buf = buildXlsx(sheets);
    await recordAudit(db, req.authCtx, "contacts.export", { channelId, rows: rows.length });
    const slug = (channel?.name ?? "tat-ca-kenh").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
      .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "kenh";
    const fname = `contacts-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", `attachment; filename="${fname}"`)
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(buf);
  });

  app.get("/v1/contacts", async (req) => {
    return { contacts: await listContactsOverview(db, req.authCtx) };
  });

  const contactUserDir = (ctx: WorkspaceContext, userKey: string) =>
    resolve(join(deps.config.dataDir, ctx.workspaceId, "users", sanitizeUserKey(userKey)));
  const USER_MD_MAX = 8000; // cùng mức agent-runtime nạp vào ngữ cảnh

  app.get("/v1/contacts/:id", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const ctx = req.authCtx;
    const contact = await getContactOverview(db, ctx, id);
    if (!contact) return reply.code(404).send({ error: "Contact không tồn tại" });
    const dir = contactUserDir(ctx, contact.userKey);
    const userMdPath = join(dir, "USER.md");
    const [profile, tags, memories, related, files, userMd, channel] = await Promise.all([
      contact.principalId ? getPrincipalProfile(db, ctx, contact.principalId) : null,
      contact.principalId ? listPrincipalTags(db, ctx, contact.principalId) : [],
      listMemoriesForUserKey(db, ctx, contact.userKey),
      getPersonRelated(db, ctx, {
        userKey: contact.userKey,
        principalId: contact.principalId,
        channelId: contact.channelId,
        externalId: contact.externalId,
      }),
      listPersonFiles(dir),
      fsReadFile(userMdPath, "utf8").catch(() => null),
      contact.channelId ? getChannelById(db, ctx, contact.channelId) : null,
    ]);
    const agent = channel ? await getAgentById(db, ctx, channel.agentId) : null;
    return {
      contact,
      profile,
      tags,
      memories,
      related,
      files,
      userMd: { exists: userMd !== null, content: userMd ?? "" },
      channel: channel
        ? {
            id: channel.id,
            name: channel.name,
            kind: channel.kind,
            agentKey: agent?.key ?? null,
            agentName: agent?.name ?? null,
          }
        : null,
      limits: PERSON_LIMITS,
    };
  });

  const optText = (max: number) =>
    z.string().max(max, `tối đa ${max} ký tự`).nullish();
  const ProfileBody = z.object({
    displayName: optText(PERSON_LIMITS.displayName),
    addressAs: optText(PERSON_LIMITS.addressAs),
    selfAddress: optText(PERSON_LIMITS.selfAddress),
    roleTitle: optText(PERSON_LIMITS.roleTitle),
    language: optText(PERSON_LIMITS.language),
    phone: optText(PERSON_LIMITS.phone),
    email: optText(PERSON_LIMITS.email),
    shareContactInfo: z.boolean().optional(),
    customFields: z
      .record(
        z.string().trim().min(1).max(PERSON_LIMITS.customFieldKey, `tên trường tối đa ${PERSON_LIMITS.customFieldKey} ký tự`),
        z.string().max(PERSON_LIMITS.customFieldValue, `giá trị tối đa ${PERSON_LIMITS.customFieldValue} ký tự`),
      )
      .refine(
        (o) => Object.keys(o).length <= PERSON_LIMITS.customFieldCount,
        `tối đa ${PERSON_LIMITS.customFieldCount} trường tùy chỉnh`,
      )
      .optional(),
    aiInstructions: z
      .string()
      .max(PERSON_LIMITS.personInstructions, `tối đa ${PERSON_LIMITS.personInstructions} ký tự`)
      .optional(),
    useInGroups: z.boolean().optional(),
  });

  app.put("/v1/contacts/:id/profile", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const parsed = ProfileBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const contact = await getContactOverview(db, req.authCtx, id);
    if (!contact?.principalId) return reply.code(404).send({ error: "Contact không tồn tại" });
    const b = parsed.data;
    const profile = await upsertPrincipalProfile(db, req.authCtx, contact.principalId, {
      displayName: b.displayName ?? null,
      addressAs: b.addressAs ?? null,
      selfAddress: b.selfAddress ?? null,
      roleTitle: b.roleTitle ?? null,
      language: b.language ?? null,
      phone: b.phone ?? null,
      email: b.email ?? null,
      shareContactInfo: b.shareContactInfo === true,
      customFields: Object.fromEntries(
        Object.entries(b.customFields ?? {})
          .map(([k, v]) => [k.trim(), v.trim()] as const)
          .filter(([k, v]) => k && v),
      ),
      aiInstructions: b.aiInstructions ?? "",
      useInGroups: b.useInGroups === true,
    });
    if (!profile) return reply.code(404).send({ error: "Contact không tồn tại" });
    await recordAudit(db, req.authCtx, "contact.profile.update", {
      contactId: id,
      principalId: contact.principalId,
      hasInstructions: profile.aiInstructions.length > 0,
      useInGroups: profile.useInGroups,
    });
    return { profile };
  });

  app.put("/v1/contacts/:id/tags", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ tagIds: z.array(z.string().uuid()).max(30, "tối đa 30 nhãn") })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const contact = await getContactOverview(db, req.authCtx, id);
    if (!contact?.principalId) return reply.code(404).send({ error: "Contact không tồn tại" });
    const tags = await setPrincipalTags(db, req.authCtx, contact.principalId, parsed.data.tagIds);
    if (!tags) return reply.code(400).send({ error: "Có nhãn không tồn tại" });
    await recordAudit(db, req.authCtx, "contact.tags.set", {
      contactId: id,
      principalId: contact.principalId,
      tags: tags.map((t) => t.name),
    });
    return { tags };
  });

  app.put("/v1/contacts/:id/user-md", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ content: z.string().max(USER_MD_MAX, `tối đa ${USER_MD_MAX} ký tự`) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const contact = await getContactOverview(db, req.authCtx, id);
    if (!contact) return reply.code(404).send({ error: "Contact không tồn tại" });
    const dir = contactUserDir(req.authCtx, contact.userKey);
    await mkdir(dir, { recursive: true });
    const content = parsed.data.content.replace(/\r\n?/g, "\n");
    await fsWriteFile(join(dir, "USER.md"), content.endsWith("\n") ? content : content + "\n", "utf8");
    await recordAudit(db, req.authCtx, "contact.user_md.update", {
      contactId: id,
      userKey: contact.userKey,
      chars: content.length,
    });
    return { ok: true };
  });

  // Xem trước đúng system prompt agent sẽ nhận khi người này nhắn (tool không kèm).
  app.get("/v1/contacts/:id/context-preview", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const q = req.query as { agent?: string; message?: string; group?: string };
    const ctx = req.authCtx;
    const contact = await getContactOverview(db, ctx, id);
    if (!contact) return reply.code(404).send({ error: "Contact không tồn tại" });
    let agent = q.agent ? await getAgentByKey(db, ctx, q.agent) : null;
    if (!agent && contact.channelId) {
      const ch = await getChannelById(db, ctx, contact.channelId);
      agent = ch ? await getAgentById(db, ctx, ch.agentId) : null;
    }
    if (!agent) return reply.code(404).send({ error: "Chưa chọn được agent để xem trước" });
    const message = (q.message ?? "").slice(0, 2000) || "Xin chào";
    const loopDeps = await buildLoopDeps(deps, ctx, agent.provider, {
      ...agentOpts(agent),
      userKey: contact.userKey,
      ...(contact.principalId ? { principalId: contact.principalId } : {}),
      channelIdentityId: contact.id,
      person: { channelKind: contact.channelKind, peerKind: q.group === "1" ? "group" : "direct" },
      sourceKind: "channel",
      accessRole: null,
    });
    const [context, knowledge, person] = await Promise.all([
      loopDeps.buildContextPrefix?.(message).catch(() => "") ?? "",
      loopDeps.buildKnowledgeContext?.(message).catch(() => "") ?? "",
      loopDeps.buildPersonContext?.(message).catch(() => "") ?? "",
    ]);
    const systemPrompt = composeSystemPrompt(agent.systemPrompt, {
      ...(context ? { context } : {}),
      ...(knowledge ? { knowledge } : {}),
      ...(person ? { person } : {}),
    });
    return {
      agent: { key: agent.key, name: agent.name },
      message,
      systemPrompt,
      chars: {
        total: systemPrompt.length,
        agentPrompt: agent.systemPrompt.length,
        context: (context ?? "").length,
        knowledge: (knowledge ?? "").length,
        person: (person ?? "").length,
      },
    };
  });

  // Nhãn — chỉ dẫn theo nhãn áp cho mọi người mang nhãn nên sửa cần ws_admin
  const TagColor = z.string().regex(/^(#[0-9a-fA-F]{6})?$/, "màu dạng #rrggbb");
  const TagBody = z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(PERSON_LIMITS.tagName, `tối đa ${PERSON_LIMITS.tagName} ký tự`),
    color: TagColor.optional(),
    aiInstructions: z
      .string()
      .max(PERSON_LIMITS.tagInstructions, `tối đa ${PERSON_LIMITS.tagInstructions} ký tự`)
      .optional(),
    useInGroups: z.boolean().optional(),
  });
  const isUniqueViolation = (err: unknown) =>
    (err as { code?: string })?.code === "23505" ||
    (err as { cause?: { code?: string } })?.cause?.code === "23505";

  app.get("/v1/contact-tags", async (req) => {
    return { tags: await listContactTags(db, req.authCtx) };
  });

  app.post("/v1/contact-tags", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = TagBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    try {
      const tag = await createContactTag(db, req.authCtx, {
        name: parsed.data.name,
        ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
        ...(parsed.data.aiInstructions !== undefined ? { aiInstructions: parsed.data.aiInstructions } : {}),
        ...(parsed.data.useInGroups !== undefined ? { useInGroups: parsed.data.useInGroups } : {}),
      });
      await recordAudit(db, req.authCtx, "contact_tag.create", { id: tag.id, name: tag.name });
      return reply.code(201).send({ tag });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "Đã có nhãn trùng tên" });
      throw err;
    }
  });

  app.patch("/v1/contact-tags/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const parsed = TagBody.partial()
      .refine((v) => Object.keys(v).length > 0, "Không có trường nào để sửa")
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const b = parsed.data;
    try {
      const tag = await updateContactTag(db, req.authCtx, id, {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.color !== undefined ? { color: b.color } : {}),
        ...(b.aiInstructions !== undefined ? { aiInstructions: b.aiInstructions } : {}),
        ...(b.useInGroups !== undefined ? { useInGroups: b.useInGroups } : {}),
      });
      if (!tag) return reply.code(404).send({ error: "Nhãn không tồn tại" });
      await recordAudit(db, req.authCtx, "contact_tag.update", { id, fields: Object.keys(b) });
      return { tag };
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "Đã có nhãn trùng tên" });
      throw err;
    }
  });

  app.delete("/v1/contact-tags/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteContactTag(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Nhãn không tồn tại" });
    await recordAudit(db, req.authCtx, "contact_tag.delete", { id });
    return { deleted: true };
  });

  // ===== Cron jobs =====
  // Lịch do quản trị viên tạo ở đây, hoặc agent tự tạo khi chat (tool cron_*,
  // xem cron-tools.ts). Giờ tính theo múi giờ của job (config.timezone lúc tạo).
  app.get("/v1/cron", async (req) => {
    const [jobs, agents] = await Promise.all([listCronJobs(db, req.authCtx), listAgents(db, req.authCtx)]);
    const agentKeyOf = new Map(agents.map((a) => [a.id, a.key]));
    const tz = deps.config.timezone;
    return {
      timezone: tz,
      jobs: jobs.map(({ origin, ...j }) => ({
        ...j,
        agentKey: agentKeyOf.get(j.agentId) ?? null,
        scheduleText: describeSchedule(j.schedule, j.timezone),
        nextRunText: formatInZone(j.nextRun, j.timezone ?? tz),
        lastRunText: j.lastRun ? formatInZone(j.lastRun, j.timezone ?? tz) : null,
        // Không trả id thô của cuộc trò chuyện — chỉ nhãn để hiển thị
        creatorText: origin
          ? origin.kind === "channel"
            ? `${origin.senderName ?? origin.senderId} · ${origin.channelName ?? origin.channelKind}${origin.peerKind === "group" ? " (nhóm)" : ""}`
            : `${origin.userName ?? "người dùng"} · Chat web`
          : null,
        deliverText: j.createdVia === "agent" ? deliverLabel(origin ?? null) : null,
      })),
    };
  });

  app.post("/v1/cron", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = CreateCronBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data;
    const tz = body.timezone ?? deps.config.timezone;
    if (!isValidTimeZone(tz)) return reply.code(400).send({ error: `Múi giờ không hợp lệ: ${tz}` });
    const now = new Date();
    let schedule: string;
    let first: Date | null;
    try {
      schedule = normalizeSchedule(body.schedule, now, tz);
      first = nextRun(schedule, now, tz);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!first) {
      return reply
        .code(400)
        .send({ error: `Lịch đã qua, không có lần chạy nào (bây giờ là ${formatInZone(now, tz)})` });
    }
    const agent = await getAgentByKey(db, req.authCtx, body.agentKey);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const job = await createCronJob(db, req.authCtx, {
      agentId: agent.id,
      name: body.name,
      schedule,
      prompt: body.prompt,
      kind: body.kind,
      nextRun: first,
      timezone: tz,
      createdVia: "dashboard",
    });
    return reply.code(201).send({ job });
  });

  app.patch("/v1/cron/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const parsed = UpdateCronBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data;
    const job = await getCronJob(db, req.authCtx, id);
    if (!job) return reply.code(404).send({ error: "Cron job không tồn tại" });
    const now = new Date();
    const patch: Parameters<typeof updateCronJob>[3] = {};
    if (body.name) patch.name = body.name;
    if (body.prompt) patch.prompt = body.prompt;
    let schedule = job.schedule;
    let tz = job.timezone;
    try {
      if (body.schedule) {
        tz = job.timezone ?? deps.config.timezone;
        schedule = normalizeSchedule(body.schedule, now, tz);
        // Lịch agent tạo giữ đúng giới hạn như khi tạo qua chat
        if (job.createdVia === "agent" && minIntervalMs(schedule, now, tz) < CRON_MIN_INTERVAL_MS) {
          return reply.code(400).send({ error: "Lịch lặp lại dày quá — tối thiểu 5 phút một lần." });
        }
        patch.schedule = schedule;
        patch.timezone = tz;
      }
      // Bật lại / đổi lịch → tính lại lần chạy kế tiếp (không chạy bù lượt đã lỡ)
      const enable = body.enabled ?? (body.schedule ? true : undefined);
      if (enable === true && (body.schedule || !job.enabled)) {
        const next = nextRun(schedule, now, tz);
        if (!next) {
          return reply.code(400).send({ error: "Lịch một lần đã qua thời điểm chạy — đổi lịch trước khi bật lại." });
        }
        patch.enabled = true;
        patch.nextRun = next;
      } else if (enable === false) {
        patch.enabled = false;
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const updated = await updateCronJob(db, req.authCtx, id, patch);
    return { ok: true, job: updated };
  });

  app.delete("/v1/cron/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteCronJob(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Cron job không tồn tại" });
    return { deleted: true };
  });

  app.get("/v1/cron/:id/runs", async (req) => {
    const { id } = req.params as { id: string };
    return { runs: await listCronRuns(db, req.authCtx, id) };
  });

  // Phiên đăng nhập codex đang chờ — giữ lại để hoàn tất bằng LINK CALLBACK dán tay.
  // Lý do: server callback bind 127.0.0.1:1455 của CHÍNH máy chạy PenAI, còn trình
  // duyệt người dùng redirect về localhost:1455 trên MÁY HỌ → chạy trên VPS thì
  // callback không bao giờ tới. Dán link vào là đổi được code (verifier PKCE nằm ở đây).
  //
  // NHIỀU phiên cùng lúc, tra theo state (01/10/2026): lớp học dùng chung một tài
  // khoản quản trị, mỗi người bấm "Đăng nhập" — trước đây chỉ giữ 1 phiên nên người
  // bấm sau hủy phiên người trước → ai dán link cũng báo "state không khớp".
  type PendingCodexLogin = { providerName: string; workspaceId: string; flow: LoginFlow; startedAt: number };
  const pendingCodexLogins = new Map<string, PendingCodexLogin>();
  const CODEX_LOGIN_MAX_PENDING = 20;

  // Đăng nhập ChatGPT (Codex OAuth) — mở trình duyệt server-side, trả URL ngay.
  // Dùng cho cả THÊM tài khoản mới lẫn đăng nhập lại: sau khi OAuth xong,
  // accountId trùng tài khoản có sẵn → cập nhật tại chỗ; mới → thêm vào pool.
  // Nhiều flow chạy song song được: cổng callback 1455 chỉ phiên đầu giữ (dùng khi
  // PenAI chạy trên chính máy người dùng), các phiên khác hoàn tất bằng dán link.
  app.post("/v1/providers/:name/login", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { name } = req.params as { name: string };
    let provider;
    try {
      provider = deps.providers.get(name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (provider instanceof AntigravityProvider || provider instanceof ClaudeCodeProvider) {
      // Luồng dán code: CLI in URL OAuth, người dùng đăng nhập rồi dán
      // authorization code vào POST .../login/code.
      try {
        const { url } = await provider.startLogin();
        return {
          authorizeUrl: url,
          mode: "paste_code",
          note:
            provider instanceof ClaudeCodeProvider
              ? "Mở link, đăng nhập tài khoản Claude (Max), copy authorization code rồi dán vào ô bên dưới."
              : "Mở link, đăng nhập Google có gói Antigravity, copy authorization code rồi dán vào ô bên dưới trong ~60 giây.",
        };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
    if (!(provider instanceof CodexProvider)) {
      return reply
        .code(400)
        .send({ error: "Provider này không dùng đăng nhập OAuth" });
    }
    const codex = provider;
    try {
      // Giữ tối đa N phiên đang chờ — quá thì hủy phiên cũ nhất
      while (pendingCodexLogins.size >= CODEX_LOGIN_MAX_PENDING) {
        const oldest = pendingCodexLogins.keys().next().value as string;
        pendingCodexLogins.get(oldest)?.flow.cancel();
        pendingCodexLogins.delete(oldest);
      }
      const flow = startLoginFlow({ save: false, openBrowser: true, optionalListen: true });
      pendingCodexLogins.set(flow.state, {
        providerName: name,
        workspaceId: req.authCtx.workspaceId,
        flow,
        startedAt: Date.now(),
      });
      // hoàn tất chạy nền: đưa tài khoản vào pool; UI poll /v1/providers
      flow.done
        .then((auth) => {
          const acc = codex.accounts.addAccount(auth);
          logger.info(`ChatGPT pool: đã thêm/cập nhật tài khoản ${acc.email ?? acc.alias}`);
        })
        .catch(() => {})
        .finally(() => {
          pendingCodexLogins.delete(flow.state);
        });
      return {
        authorizeUrl: flow.url,
        mode: "auto_or_paste_url",
        note:
          "Mở link, đăng nhập tài khoản ChatGPT muốn thêm. Trình duyệt sẽ dừng ở trang lỗi " +
          "localhost:1455 — copy TOÀN BỘ link trên thanh địa chỉ rồi dán vào ô bên dưới.",
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (/EADDRINUSE/.test(msg)) {
        return reply.code(409).send({
          error: "Đang có một phiên đăng nhập khác chạy dở — hoàn tất hoặc chờ hết hạn (10 phút) rồi thử lại",
        });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // Codex: dán LINK CALLBACK (http://localhost:1455/auth/callback?code=...) sau khi
  // đăng nhập ChatGPT. Phiên phải là phiên vừa bấm "Đăng nhập" ở Dashboard (verifier
  // PKCE + state giữ trong RAM) — restart server hoặc quá 10 phút thì phải lấy link mới.
  app.post("/v1/providers/:name/login/callback", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { name } = req.params as { name: string };
    const raw = String((req.body as { url?: string })?.url ?? "").trim();
    if (!raw) return reply.code(400).send({ error: "Thiếu link callback" });
    let provider;
    try {
      provider = deps.providers.get(name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (!(provider instanceof CodexProvider)) {
      return reply.code(400).send({ error: "Provider này không dùng luồng dán link callback" });
    }
    // Tìm đúng phiên theo state trong link; chỉ dán code (không có state) thì
    // dùng được khi workspace này chỉ có đúng một phiên đang chờ.
    let parsedState: string | undefined;
    try {
      parsedState = parseCodexCallback(raw).state;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const mine = [...pendingCodexLogins.values()].filter(
      (p) => p.providerName === name && p.workspaceId === req.authCtx.workspaceId,
    );
    const pending = parsedState
      ? mine.find((p) => p.flow.state === parsedState)
      : mine.length === 1
        ? mine[0]
        : undefined;
    if (!pending) {
      return reply.code(409).send({
        error: parsedState
          ? "Link này thuộc phiên đăng nhập đã hết hạn, đã dùng hoặc đã bị hủy (server khởi động lại / quá 10 phút) — bấm Đăng nhập để lấy link mới"
          : mine.length
            ? "Đang có nhiều phiên đăng nhập chờ — hãy dán TOÀN BỘ link callback (có cả state), không chỉ mã code"
            : "Không có phiên đăng nhập nào đang chờ (hết hạn hoặc server đã khởi động lại) — bấm Đăng nhập để lấy link mới",
      });
    }
    try {
      const auth = await pending.flow.submit(raw);
      // addAccount idempotent theo accountId; gọi ở đây để chắc chắn vào pool kể cả
      // khi promise done đã bị timeout reject trước đó.
      const acc = provider.accounts.addAccount(auth);
      pendingCodexLogins.delete(pending.flow.state);
      logger.info(`ChatGPT pool: đã thêm/cập nhật tài khoản ${acc.email ?? acc.alias} (dán link)`);
      return { ok: true, email: acc.email ?? acc.alias, alias: acc.alias };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Antigravity: dán authorization code sau khi đăng nhập Google
  app.post("/v1/providers/:name/login/code", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { name } = req.params as { name: string };
    const code = String((req.body as { code?: string })?.code ?? "").trim();
    if (!code) return reply.code(400).send({ error: "Thiếu authorization code" });
    let provider;
    try {
      provider = deps.providers.get(name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (!(provider instanceof AntigravityProvider || provider instanceof ClaudeCodeProvider)) {
      return reply.code(400).send({ error: "Provider này không dùng luồng dán code" });
    }
    const result = await provider.submitCode(code);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message };
  });

  // Claude Code: dán thẳng token dài hạn (chạy `claude setup-token` ở máy bất kỳ)
  app.post("/v1/providers/:name/login/token", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { name } = req.params as { name: string };
    const token = String((req.body as { token?: string })?.token ?? "").trim();
    if (!token) return reply.code(400).send({ error: "Thiếu token" });
    let provider;
    try {
      provider = deps.providers.get(name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (!(provider instanceof ClaudeCodeProvider)) {
      return reply.code(400).send({ error: "Provider này không nhận token dán trực tiếp" });
    }
    const result = await provider.setToken(token);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message };
  });

  // Xóa 1 tài khoản ChatGPT khỏi pool
  app.delete("/v1/providers/:name/accounts/:alias", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { name, alias } = req.params as { name: string; alias: string };
    let provider;
    try {
      provider = deps.providers.get(name, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    if (!(provider instanceof CodexProvider)) {
      return reply.code(400).send({ error: "Provider này không có pool tài khoản" });
    }
    if (!provider.accounts.removeAccount(alias)) {
      return reply.code(404).send({ error: `Tài khoản "${alias}" không tồn tại` });
    }
    return { removed: true };
  });

  // ===== API keys management =====
  app.get("/v1/api-keys", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    return { keys: await listApiKeys(db, req.authCtx) };
  });
  app.post("/v1/api-keys", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as { name?: string; role?: WorkspaceRole };
    const role = b.role && ["ws_admin", "operator", "viewer"].includes(b.role) ? b.role : "operator";
    if (!b.name) return reply.code(400).send({ error: "Thiếu name" });
    const r = await createApiKey(db, req.authCtx, { name: b.name, role });
    await recordAudit(db, req.authCtx, "apikey.create", { name: b.name, role });
    return reply.code(201).send({ id: r.id, apiKey: r.apiKey, note: "Lưu ngay — chỉ hiện 1 lần" });
  });
  app.delete("/v1/api-keys/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await revokeApiKey(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Key không tồn tại" });
    await recordAudit(db, req.authCtx, "apikey.revoke", { id });
    return { revoked: true };
  });

  // ===== Audit log =====
  app.get("/v1/audit", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    return { entries: await listAudit(db, req.authCtx) };
  });

  // ===== Sessions =====
  app.get("/v1/sessions", async (req) => {
    return { sessions: await listSessions(db, req.authCtx) };
  });

  app.post("/v1/sessions", async (req, reply) => {
    if (!requireChat(req, reply)) return;
    const parsed = CreateSessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    const agent = await getAgentByKey(db, req.authCtx, parsed.data.agentKey);
    if (!agent) {
      return reply.code(404).send({ error: "Agent không tồn tại" });
    }
    const session = await createSession(db, req.authCtx, {
      agentId: agent.id,
      ownerUserId: req.authCtx.userId,
      ...(parsed.data.title ? { title: parsed.data.title } : {}),
    });
    return reply.code(201).send({ session });
  });

  app.get("/v1/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await getSession(db, req.authCtx, id);
    if (!session || !(await canAccessAgent(db, req.authCtx, session.agentId))) {
      return reply.code(404).send({ error: "Session không tồn tại" });
    }
    return { messages: await loadMessages(db, req.authCtx, id) };
  });

  app.delete("/v1/sessions/:id", async (req, reply) => {
    if (!requireChat(req, reply)) return;
    const { id } = req.params as { id: string };
    // member: getSession đã lọc theo owner → không xóa được phiên người khác
    if (!(await getSession(db, req.authCtx, id))) {
      return reply.code(404).send({ error: "Session không tồn tại" });
    }
    const ok = await deleteSession(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Session không tồn tại" });
    return { deleted: true };
  });

  // ===== Knowledge Vault =====
  app.get("/v1/vault", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    return { docs: await listVaultDocs(db, req.authCtx) };
  });

  app.get("/v1/vault/settings", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    return { settings: await getVaultSettings(db, req.authCtx) };
  });
  app.put("/v1/vault/settings", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = VaultSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const settings = await updateVaultSettings(db, req.authCtx, parsed.data);
    await recordAudit(db, req.authCtx, "vault.settings.update", parsed.data);
    return { settings, reindexRequired: true };
  });

  app.get("/v1/vault/collections", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    return { collections: await listVaultCollections(db, req.authCtx) };
  });
  app.post("/v1/vault/collections", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = VaultCollectionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    try {
      const collection = await createVaultCollection(db, req.authCtx, parsed.data);
      await recordAudit(db, req.authCtx, "vault.collection.create", { id: collection.id, slug: collection.slug });
      return reply.code(201).send({ collection });
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
  app.patch("/v1/vault/collections/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = VaultCollectionPatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const { id } = req.params as { id: string };
    if (!(await updateVaultCollection(db, req.authCtx, id, parsed.data))) {
      return reply.code(404).send({ error: "Collection không tồn tại" });
    }
    await recordAudit(db, req.authCtx, "vault.collection.update", { id, ...parsed.data });
    return { updated: true };
  });
  app.delete("/v1/vault/collections/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const status = await deleteVaultCollection(db, req.authCtx, id);
    if (status === "missing") return reply.code(404).send({ error: "Collection không tồn tại" });
    if (status === "default") return reply.code(409).send({ error: "Không thể xóa Collection mặc định" });
    if (status === "not_empty") return reply.code(409).send({ error: "Hãy chuyển hoặc xóa tài liệu trước" });
    await recordAudit(db, req.authCtx, "vault.collection.delete", { id });
    return { deleted: true };
  });

  app.get("/v1/vault/collections/:id/grants", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    return { grants: await listVaultCollectionGrants(db, req.authCtx, id) };
  });
  app.put("/v1/vault/collections/:id/grants", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = z.object({ grants: z.array(VaultGrantBody).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const { id } = req.params as { id: string };
    try {
      await replaceVaultCollectionGrants(db, req.authCtx, id, parsed.data.grants);
      await recordAudit(db, req.authCtx, "vault.collection.grants.replace", { id, count: parsed.data.grants.length });
      return { updated: true, count: parsed.data.grants.length };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get("/v1/vault/access-options", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    return {
      agents: await listVaultAccessAgents(db, req.authCtx),
      principals: await listPrincipals(db, req.authCtx),
      conversations: await listConversations(db, req.authCtx),
    };
  });

  // Preview chạy đúng hybrid + ACL như agent. Nếu bỏ agentId, dùng agent đầu tiên.
  app.get("/v1/vault-search", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsedQ = z
      .object({
        q: z.string().trim().min(1).max(2000),
        agentId: z.string().uuid().optional(),
        principalId: z.string().uuid().optional(),
        conversationId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(30).optional(),
      })
      .safeParse(req.query);
    if (!parsedQ.success) return reply.code(400).send({ error: zodMessage(parsedQ.error) });
    const qv = parsedQ.data;
    const agentId = qv.agentId ?? (await listVaultAccessAgents(db, req.authCtx))[0]?.id;
    if (!agentId) return reply.code(400).send({ error: "Workspace chưa có agent để preview ACL" });
    const principalId = qv.principalId ?? await getOrCreateMemberPrincipal(db, req.authCtx).catch(() => undefined);
    const hits = await hybridVaultSearch(deps, req.authCtx, {
      agentId,
      ...(principalId ? { principalId } : {}),
      ...(qv.conversationId ? { conversationId: qv.conversationId } : {}),
      role: req.authCtx.role,
    }, qv.q, qv.limit);
    return { hits };
  });

  app.post("/v1/vault/reindex", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const results = await reindexVault(deps, req.authCtx);
    await recordAudit(db, req.authCtx, "vault.reindex", {
      total: results.length,
      failed: results.filter((r) => !r.ok).length,
    });
    return { results };
  });

  app.post("/v1/vault/:slug/reindex", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { slug } = req.params as { slug: string };
    const doc = await getVaultDoc(db, req.authCtx, slug);
    if (!doc) return reply.code(404).send({ error: "Không có tài liệu" });
    return { index: await indexVaultDocument(deps, req.authCtx, doc) };
  });

  app.get("/v1/vault/:slug", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { slug } = req.params as { slug: string };
    const d = await getVaultDoc(db, req.authCtx, slug);
    if (!d) return reply.code(404).send({ error: "Không có tài liệu" });
    return { doc: d };
  });
  app.post("/v1/vault", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const parsed = VaultDocumentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    try {
      const result = await writeAndIndexVaultDocument(deps, req.authCtx, parsed.data);
      await recordAudit(db, req.authCtx, "vault.document.upsert", {
        id: result.doc.id,
        slug: result.doc.slug,
        collectionId: result.doc.collectionId,
        chunks: result.index.chunks,
        embedded: result.index.embedded,
      });
      return reply.code(201).send(result);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
  app.delete("/v1/vault/:id", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteVaultDoc(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Không có tài liệu" });
    return { deleted: true };
  });

  // Upload file văn phòng vào Kho tri thức: trích text (pdf/docx/xlsx/txt/md/csv...)
  // → tạo tài liệu (slug từ tên file) → chunk + embed. File y hệt bản cũ thì bỏ
  // qua re-embed (đối chiếu content_hash) — upload lại không tốn tiền API.
  app.post("/v1/vault/upload", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const parsed = VaultUploadBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const results: Array<{
      name: string;
      slug?: string;
      ok: boolean;
      chunks?: number;
      embedded?: boolean;
      skipped?: boolean;
      warning?: string;
      error?: string;
    }> = [];
    for (const file of parsed.data.files) {
      try {
        const buf = Buffer.from(file.contentB64, "base64");
        if (buf.length > UPLOAD_FILE_MAX_BYTES) throw new Error("File quá 100MB");
        const text = await extractDocumentText(file.name, buf);
        if (!text) throw new Error("File không có text trích được");
        if (text.length > 2_000_000) throw new Error("Nội dung sau trích vượt 2 triệu ký tự");
        const baseName = file.name.replace(/\.[^.]+$/, "");
        const slug = slugify(baseName) || `tai-lieu-${Date.now()}`;
        const result = await writeAndIndexVaultDocument(deps, req.authCtx, {
          slug,
          title: baseName,
          content: text,
          ...(parsed.data.collectionId ? { collectionId: parsed.data.collectionId } : {}),
          sourceFile: file.name,
        });
        const index = result.index as { chunks: number; embedded: boolean; warning?: string; skipped?: boolean };
        results.push({
          name: file.name,
          slug,
          ok: true,
          chunks: index.chunks,
          embedded: index.embedded,
          ...(index.skipped ? { skipped: true } : {}),
          ...(index.warning ? { warning: index.warning } : {}),
        });
      } catch (error) {
        results.push({ name: file.name, ok: false, error: (error as Error).message });
      }
    }
    await recordAudit(db, req.authCtx, "vault.upload", {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      names: results.map((r) => r.name).slice(0, 20),
    }).catch(() => {});
    return { results };
  });

  // ===== Knowledge Graph =====
  app.get("/v1/kg/entities", async (req) => {
    return { entities: await listEntities(db, req.authCtx) };
  });
  app.get("/v1/kg/traverse/:name", async (req) => {
    const { name } = req.params as { name: string };
    const depth = Number((req.query as { depth?: string }).depth ?? 2);
    return { nodes: await traverseGraph(db, req.authCtx, name, depth) };
  });
  app.post("/v1/kg/entities", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const b = req.body as { name?: string; type?: string; summary?: string };
    if (!b.name) return reply.code(400).send({ error: "Thiếu name" });
    const id = await upsertEntity(db, req.authCtx, {
      name: b.name, ...(b.type ? { type: b.type } : {}), ...(b.summary ? { summary: b.summary } : {}),
    });
    return reply.code(201).send({ id });
  });
  // Trích entity/relation từ văn bản bằng LLM rồi lưu vào graph
  app.post("/v1/kg/extract", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const b = req.body as { text?: string; agentKey?: string };
    if (!b.text || !b.agentKey) return reply.code(400).send({ error: "Thiếu text/agentKey" });
    const agent = await getAgentByKey(db, req.authCtx, b.agentKey);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    let provider;
    try {
      provider = deps.providers.get(agent.provider, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
    const res = await provider.chat({
      model: agent.model,
      system:
        "Trích xuất thực thể và quan hệ từ văn bản. CHỈ trả về JSON hợp lệ dạng " +
        '{"entities":[{"name","type","summary"}],"relations":[{"from","to","relation"}]}. ' +
        "Không thêm giải thích.",
      messages: [{ role: "user", content: b.text.slice(0, 8000) }],
      maxTokens: 1000,
    });
    let parsed: { entities?: Array<{ name: string; type?: string; summary?: string }>; relations?: Array<{ from: string; to: string; relation: string }> };
    try {
      const raw = (res.content ?? "").replace(/```json\n?|```/g, "").trim();
      parsed = JSON.parse(raw);
    } catch {
      return reply.code(502).send({ error: "LLM không trả JSON hợp lệ", raw: res.content });
    }
    const idByName = new Map<string, string>();
    for (const e of parsed.entities ?? []) {
      const id = await upsertEntity(db, req.authCtx, {
        name: e.name, ...(e.type ? { type: e.type } : {}), ...(e.summary ? { summary: e.summary } : {}),
      });
      idByName.set(e.name.toLowerCase(), id);
    }
    let relCount = 0;
    for (const r of parsed.relations ?? []) {
      const fromId = idByName.get(r.from.toLowerCase()) ?? (await upsertEntity(db, req.authCtx, { name: r.from }));
      const toId = idByName.get(r.to.toLowerCase()) ?? (await upsertEntity(db, req.authCtx, { name: r.to }));
      await addRelation(db, req.authCtx, fromId, toId, r.relation);
      relCount++;
    }
    return { entities: parsed.entities?.length ?? 0, relations: relCount };
  });

  // ===== Self-evolution =====
  // Phân tích session/trace gần đây → LLM đề xuất cải thiện → lưu thành memory
  // quan trọng (auto-adapt). Guardrail: chỉ BỔ SUNG hướng dẫn, KHÔNG đổi
  // danh tính/mục đích lõi của agent.
  app.post("/v1/agents/:key/evolve", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { key } = req.params as { key: string };
    const agent = await getAgentByKey(db, req.authCtx, key);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const recent = await listTraces(db, req.authCtx, 30);
    const agentTraces = recent.filter((t) => t.agentId === agent.id);
    const errors = agentTraces.filter((t) => t.error).length;
    let provider;
    try {
      provider = deps.providers.get(agent.provider, req.authCtx.workspaceId);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
    const res = await provider.chat({
      model: agent.model,
      system:
        "Bạn là chuyên gia tối ưu trợ lý AI. Dựa trên system prompt và số liệu, " +
        "đề xuất 1-3 lời khuyên NGẮN để agent phục vụ tốt hơn (phong cách, lưu ý). " +
        "TUYỆT ĐỐI không đổi danh tính/tên/mục đích cốt lõi. Mỗi lời khuyên 1 dòng, bắt đầu bằng '- '.",
      messages: [
        {
          role: "user",
          content:
            `System prompt hiện tại:\n${agent.systemPrompt}\n\n` +
            `Số liệu: ${agentTraces.length} phiên gần đây, ${errors} lỗi.`,
        },
      ],
      maxTokens: 400,
    });
    const suggestions = (res.content ?? "")
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter((l) => l.length > 5)
      .slice(0, 3);
    for (const s of suggestions) {
      await addMemory(db, req.authCtx, {
        agentId: agent.id,
        tier: "semantic",
        content: `[tự cải thiện] ${s}`,
        importance: 0.75,
      });
    }
    return { applied: suggestions.length, suggestions };
  });

  // ===== Tracing + Usage caps =====
  app.get("/v1/traces", async (req) => {
    return { traces: await listTraces(db, req.authCtx) };
  });
  app.get("/v1/usage", async (req) => {
    const used = await monthTokens(db, req.authCtx.workspaceId);
    const cap = await workspaceCap(db, req.authCtx.workspaceId);
    return { monthTokens: used, cap };
  });
  app.put("/v1/usage/cap", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as { monthlyTokenLimit?: number };
    if (typeof b.monthlyTokenLimit !== "number") {
      return reply.code(400).send({ error: "Thiếu monthlyTokenLimit (số)" });
    }
    await setUsageCap(db, req.authCtx, b.monthlyTokenLimit);
    return { ok: true };
  });

  // ===== Hooks =====
  app.get("/v1/hooks", async (req) => {
    return { hooks: await listHooks(db, req.authCtx) };
  });
  app.post("/v1/hooks", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as { event?: string; matcher?: string; url?: string };
    const events = ["pre_tool_use", "post_tool_use", "stop", "session_start"];
    if (!b.event || !events.includes(b.event) || !b.url) {
      return reply.code(400).send({ error: `event ∈ ${events.join("|")} + url bắt buộc` });
    }
    const h = await createHook(db, req.authCtx, {
      event: b.event, ...(b.matcher ? { matcher: b.matcher } : {}), url: b.url,
    });
    return reply.code(201).send({ hook: h });
  });
  app.delete("/v1/hooks/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteHook(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Hook không tồn tại" });
    return { deleted: true };
  });

  // ===== Agent webhooks (inbound trigger, HMAC) =====
  app.get("/v1/agents/:key/webhooks", async (req, reply) => {
    const { key } = req.params as { key: string };
    const agent = await getAgentByKey(db, req.authCtx, key);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    return { webhooks: await listAgentWebhooks(db, req.authCtx) };
  });
  app.post("/v1/agents/:key/webhooks", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { key } = req.params as { key: string };
    const agent = await getAgentByKey(db, req.authCtx, key);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const secret = "whsec_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const wh = await createAgentWebhook(db, req.authCtx, agent.id, encryptSecret(secret));
    return reply.code(201).send({
      id: wh.id,
      url: `/webhooks/agent/${wh.id}`,
      secret,
      note: "Lưu secret ngay (chỉ hiện 1 lần). Ký payload: HMAC-SHA256(secret, timestamp + '.' + body). " +
        "Gửi header x-penai-signature, x-penai-timestamp, x-penai-nonce.",
    });
  });

  // ===== Teams / orchestration =====
  app.get("/v1/teams", async (req) => {
    return { teams: await listTeams(db, req.authCtx) };
  });
  app.post("/v1/teams", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as { name?: string };
    if (!b.name) return reply.code(400).send({ error: "Thiếu name" });
    const t = await createTeam(db, req.authCtx, b.name);
    return reply.code(201).send({ team: t });
  });
  app.post("/v1/teams/:id/members", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { agentKey?: string; role?: string };
    if (!b.agentKey) return reply.code(400).send({ error: "Thiếu agentKey" });
    const agent = await getAgentByKey(db, req.authCtx, b.agentKey);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    await addTeamMember(db, req.authCtx, id, agent.id, b.role);
    return { ok: true };
  });
  app.get("/v1/teams/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    return { members: await listTeamMembers(db, req.authCtx, id) };
  });
  app.get("/v1/teams/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return { tasks: await listTeamTasks(db, req.authCtx, id) };
  });
  app.post("/v1/teams/:id/tasks", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { title?: string; description?: string };
    if (!b.title) return reply.code(400).send({ error: "Thiếu title" });
    const t = await createTeamTask(db, req.authCtx, {
      teamId: id, title: b.title, ...(b.description ? { description: b.description } : {}),
    });
    return reply.code(201).send({ task: t });
  });
  app.post("/v1/agent-links", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as { fromAgentKey?: string; toAgentKey?: string; mode?: "sync" | "async" };
    if (!b.fromAgentKey || !b.toAgentKey) {
      return reply.code(400).send({ error: "Thiếu fromAgentKey/toAgentKey" });
    }
    const from = await getAgentByKey(db, req.authCtx, b.fromAgentKey);
    const to = await getAgentByKey(db, req.authCtx, b.toAgentKey);
    if (!from || !to) return reply.code(404).send({ error: "Agent không tồn tại" });
    await createAgentLink(db, req.authCtx, from.id, to.id, b.mode ?? "sync");
    return { ok: true };
  });

  // ===== Skills =====

  // Ghi lại thư mục skill trên đĩa từ DB (sau mỗi thay đổi nội dung/file)
  async function rematerializeSkill(ctx: WorkspaceContext, skillId: string): Promise<void> {
    const s = await getSkillById(db, ctx, skillId);
    if (!s) return;
    const files = await listSkillFiles(db, ctx, skillId);
    await materializeSkill(
      deps.config.dataDir,
      ctx.workspaceId,
      s.slug,
      s.content,
      files.map((f) => ({ path: f.path, contentB64: f.contentB64 })),
    );
  }

  app.get("/v1/skills", async (req) => {
    const rows = await listSkills(db, req.authCtx);
    // kèm số file để bảng hiển thị — nhẹ vì chỉ đếm
    const counts = new Map<string, number>();
    for (const s of rows) {
      counts.set(s.id, (await listSkillFiles(db, req.authCtx, s.id)).length);
    }
    return {
      skills: rows.map((s) => ({ ...s, fileCount: counts.get(s.id) ?? 0 })),
    };
  });
  app.post("/v1/skills", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as { slug?: string; name?: string; description?: string; content?: string };
    if (!b.content) return reply.code(400).send({ error: "Thiếu content" });
    // Dán nguyên SKILL.md có frontmatter thì tự lấy name/description/slug/tags
    const fm = parseSkillFrontmatter(b.content);
    const name = b.name?.trim() || fm.fields.name || "";
    const description = b.description?.trim() || fm.fields.description || "";
    const slug = b.slug?.trim() || fm.fields.slug || (name ? slugify(name) : "");
    if (!slug || !name || !description) {
      return reply.code(400).send({
        error:
          "Thiếu slug/name/description — điền vào form hoặc thêm frontmatter (--- name: ... description: ... ---) ở đầu nội dung",
      });
    }
    const s = await createSkill(db, req.authCtx, {
      slug,
      name,
      description,
      // giữ nguyên nội dung gốc (kể cả frontmatter) để không mất thông tin
      content: b.content,
    });
    await rematerializeSkill(req.authCtx, s.id);
    return reply.code(201).send({ skill: s, parsedTags: fm.tags });
  });

  // Nạp skill từ file ZIP (SKILL.md + scripts/ + references/). Trùng slug = ghi đè
  // có snapshot phiên bản cũ để khôi phục được.
  app.post("/v1/skills/import", { bodyLimit: UPLOAD_BODY_MAX_BYTES }, async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as { zipBase64?: string; slug?: string };
    if (!b.zipBase64) return reply.code(400).send({ error: "Thiếu zipBase64" });
    let payload;
    try {
      payload = readSkillZip(Buffer.from(b.zipBase64, "base64"));
    } catch (err) {
      return reply.code(400).send({ error: `ZIP không hợp lệ: ${(err as Error).message}` });
    }
    const fm = parseSkillFrontmatter(payload.skillMd);
    const name = fm.fields.name ?? "";
    const description = fm.fields.description ?? "";
    const slug = b.slug?.trim() || fm.fields.slug || (name ? slugify(name) : "");
    if (!slug || !name || !description) {
      return reply.code(400).send({ error: "SKILL.md trong ZIP thiếu frontmatter name/description" });
    }
    const existing = await getSkillBySlug(db, req.authCtx, slug);
    let skillId: string;
    let version = 1;
    if (existing) {
      await snapshotSkill(db, req.authCtx, existing.id, "trước khi ghi đè bằng ZIP");
      await updateSkill(db, req.authCtx, existing.id, {
        name,
        description,
        content: payload.skillMd,
      });
      await replaceSkillFiles(db, req.authCtx, existing.id, payload.files);
      version = await bumpSkillVersion(db, req.authCtx, existing.id);
      skillId = existing.id;
    } else {
      const s = await createSkill(db, req.authCtx, {
        slug,
        name,
        description,
        content: payload.skillMd,
      });
      await replaceSkillFiles(db, req.authCtx, s.id, payload.files);
      skillId = s.id;
    }
    await rematerializeSkill(req.authCtx, skillId);
    return reply.code(existing ? 200 : 201).send({
      skill: { id: skillId, slug, name, version },
      fileCount: payload.files.length,
      overwritten: !!existing,
    });
  });

  // Tải skill về dạng ZIP (chia sẻ giữa các phòng ban / backup tay)
  app.get("/v1/skills/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await getSkillById(db, req.authCtx, id);
    if (!s) return reply.code(404).send({ error: "Skill không tồn tại" });
    const files = await listSkillFiles(db, req.authCtx, id);
    const zip = buildSkillZip(
      s.content,
      files.map((f) => ({ path: f.path, contentB64: f.contentB64 })),
    );
    return reply
      .type("application/zip")
      .header("Content-Disposition", `attachment; filename="${s.slug}.zip"`)
      .send(zip);
  });

  app.get("/v1/skills/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await listSkills(db, req.authCtx);
    const s = rows.find((x) => x.id === id);
    if (!s) return reply.code(404).send({ error: "Skill không tồn tại" });
    return { skill: s };
  });

  app.patch("/v1/skills/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string; description?: string; content?: string };
    // Snapshot bản cũ trước khi sửa — xem lại/khôi phục được trong tab Phiên bản
    await snapshotSkill(db, req.authCtx, id, "trước khi sửa");
    const s = await updateSkill(db, req.authCtx, id, b);
    if (!s) return reply.code(404).send({ error: "Skill không tồn tại / không có gì để sửa" });
    const version = await bumpSkillVersion(db, req.authCtx, id);
    await rematerializeSkill(req.authCtx, id);
    return { skill: { ...s, version } };
  });
  app.delete("/v1/skills/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const s = await getSkillById(db, req.authCtx, id);
    const ok = await deleteSkill(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Skill không tồn tại" });
    if (s) await removeSkillDir(deps.config.dataDir, req.authCtx.workspaceId, s.slug);
    return { deleted: true };
  });

  // ---- File kèm skill (scripts/, references/) ----
  app.get("/v1/skills/:id/files", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getSkillById(db, req.authCtx, id))) {
      return reply.code(404).send({ error: "Skill không tồn tại" });
    }
    const rows = await listSkillFiles(db, req.authCtx, id);
    return {
      files: rows.map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, updatedAt: f.updatedAt })),
    };
  });
  app.get("/v1/skills/:id/files/content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: "Thiếu path" });
    const rows = await listSkillFiles(db, req.authCtx, id);
    const f = rows.find((x) => x.path === q.path);
    if (!f) return reply.code(404).send({ error: "File không tồn tại" });
    return { path: f.path, contentB64: f.contentB64, sizeBytes: f.sizeBytes };
  });
  app.put("/v1/skills/:id/files", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { path?: string; content?: string; contentB64?: string };
    const safe = b.path ? sanitizeSkillPath(b.path) : null;
    if (!safe) return reply.code(400).send({ error: "path không hợp lệ" });
    if (b.content === undefined && !b.contentB64) {
      return reply.code(400).send({ error: "Thiếu content (text) hoặc contentB64" });
    }
    if (!(await getSkillById(db, req.authCtx, id))) {
      return reply.code(404).send({ error: "Skill không tồn tại" });
    }
    const contentB64 = b.contentB64 ?? Buffer.from(b.content ?? "", "utf8").toString("base64");
    if (Buffer.from(contentB64, "base64").length > UPLOAD_FILE_MAX_BYTES) {
      return reply.code(400).send({ error: "File quá 100MB" });
    }
    await snapshotSkill(db, req.authCtx, id, `trước khi sửa file ${safe}`);
    await upsertSkillFile(db, req.authCtx, id, safe, contentB64);
    const version = await bumpSkillVersion(db, req.authCtx, id);
    await rematerializeSkill(req.authCtx, id);
    return { saved: true, path: safe, version };
  });
  app.delete("/v1/skills/:id/files", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: "Thiếu path" });
    await snapshotSkill(db, req.authCtx, id, `trước khi xóa file ${q.path}`);
    const ok = await deleteSkillFile(db, req.authCtx, id, q.path);
    if (!ok) return reply.code(404).send({ error: "File không tồn tại" });
    const version = await bumpSkillVersion(db, req.authCtx, id);
    await rematerializeSkill(req.authCtx, id);
    return { deleted: true, version };
  });

  // ---- Phiên bản skill ----
  app.get("/v1/skills/:id/versions", async (req) => {
    const { id } = req.params as { id: string };
    return { versions: await listSkillVersions(db, req.authCtx, id) };
  });
  app.post("/v1/skills/versions/:versionId/restore", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { versionId } = req.params as { versionId: string };
    const v = await getSkillVersion(db, req.authCtx, versionId);
    if (!v) return reply.code(404).send({ error: "Phiên bản không tồn tại" });
    // Chụp bản hiện tại rồi mới đắp bản cũ lên — không mất gì cả
    await snapshotSkill(db, req.authCtx, v.skillId, `trước khi khôi phục v${v.version}`);
    await updateSkill(db, req.authCtx, v.skillId, {
      name: v.name,
      description: v.description,
      content: v.content,
    });
    const files = Array.isArray(v.files)
      ? (v.files as Array<{ path: string; contentB64: string }>)
      : [];
    await replaceSkillFiles(db, req.authCtx, v.skillId, files);
    const version = await bumpSkillVersion(db, req.authCtx, v.skillId);
    await rematerializeSkill(req.authCtx, v.skillId);
    return { restored: true, fromVersion: v.version, newVersion: version };
  });

  // ---- Danh sách agent kèm cờ granted với 1 skill (dialog Phân quyền) ----
  app.get("/v1/skills/:id/agents", async (req) => {
    const { id } = req.params as { id: string };
    return { agents: await listAgentsWithSkillGrant(db, req.authCtx, id) };
  });

  // Bật/tắt skill
  app.post("/v1/skills/:id/toggle", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { enabled?: boolean };
    if (typeof b?.enabled !== "boolean") {
      return reply.code(400).send({ error: "Thiếu enabled (boolean)" });
    }
    const ok = await toggleSkill(db, req.authCtx, id, b.enabled);
    if (!ok) return reply.code(404).send({ error: "Skill không tồn tại" });
    return { ok: true };
  });

  // Phạm vi skill: workspace (mọi agent) | granted (chỉ agent được cấp)
  app.post("/v1/skills/:id/visibility", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { visibility?: string };
    if (b?.visibility !== "workspace" && b?.visibility !== "granted") {
      return reply.code(400).send({ error: "visibility phải là workspace | granted" });
    }
    const ok = await setSkillVisibility(db, req.authCtx, id, b.visibility);
    if (!ok) return reply.code(404).send({ error: "Skill không tồn tại" });
    return { ok: true };
  });

  // Grant / revoke skill cho agent (bảng skill_agent_grants)
  app.post("/v1/skills/:id/grants/agent", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { agentId?: string; canManage?: boolean };
    if (!b?.agentId) return reply.code(400).send({ error: "Thiếu agentId" });
    await grantSkillToAgent(db, req.authCtx, id, b.agentId, {
      ...(typeof b.canManage === "boolean" ? { canManage: b.canManage } : {}),
      grantedBy: req.authCtx.userId,
    });
    return { granted: true };
  });

  app.delete("/v1/skills/:id/grants/agent/:agentId", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id, agentId } = req.params as { id: string; agentId: string };
    const ok = await revokeSkillFromAgent(db, req.authCtx, id, agentId);
    return { revoked: ok };
  });

  // Danh sách skill kèm cờ granted cho 1 agent — cho tab Skills của agent
  app.get("/v1/agents/:id/skills", async (req) => {
    const { id } = req.params as { id: string };
    const rows = await listSkillsWithGrantStatus(db, req.authCtx, id);
    return {
      skills: rows.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        visibility: s.visibility,
        granted: s.granted,
      })),
    };
  });

  // ===== Custom tools =====
  app.get("/v1/custom-tools", async (req) => {
    return { tools: await listCustomTools(db, req.authCtx) };
  });
  app.post("/v1/custom-tools", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as {
      name?: string; description?: string; commandTemplate?: string;
      paramsSchema?: Record<string, unknown>; env?: string; requiresApproval?: boolean;
    };
    if (!b.name || !b.description || !b.commandTemplate) {
      return reply.code(400).send({ error: "Thiếu name/description/commandTemplate" });
    }
    if (!/^[a-z0-9_]+$/.test(b.name)) {
      return reply.code(400).send({ error: "name chỉ gồm a-z0-9_" });
    }
    const t = await createCustomTool(db, req.authCtx, {
      name: b.name,
      description: b.description,
      commandTemplate: b.commandTemplate,
      ...(b.paramsSchema ? { paramsSchema: b.paramsSchema } : {}),
      ...(b.env ? { envEncrypted: encryptSecret(b.env) } : {}),
      ...(typeof b.requiresApproval === "boolean" ? { requiresApproval: b.requiresApproval } : {}),
    });
    return reply.code(201).send({
      tool: { id: t.id, name: t.name },
      note: "Có hiệu lực ở lượt chat tiếp theo (không cần restart).",
    });
  });
  app.delete("/v1/custom-tools/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteCustomTool(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Custom tool không tồn tại" });
    return { deleted: true };
  });

  // ===== MCP servers =====
  app.get("/v1/mcp", async (req) => {
    const rows = await listMcpServers(db, req.authCtx);
    // kèm trạng thái kết nối thật để admin thấy server nào hỏng và vì sao
    return {
      servers: rows.map((s) => {
        const st = deps.mcp?.statusOf(s.id);
        return {
          ...s,
          envEncrypted: undefined,
          oauthEncrypted: undefined,
          hasOauth: !!s.oauthEncrypted,
          connected: st?.connected ?? false,
          toolCount: st?.toolCount ?? 0,
          tools: st?.tools ?? [],
          error: st?.error ?? null,
          needsAuth: st?.needsAuth ?? false,
          authUrl: st?.authUrl ?? null,
          lastPingAt: st?.lastPingAt ?? null,
        };
      }),
    };
  });

  // Thử kết nối trước khi lưu
  app.post("/v1/mcp/test", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as {
      name?: string; transport?: string; command?: string;
      args?: string[]; url?: string; env?: string;
    };
    if (!b.transport) return reply.code(400).send({ error: "Thiếu transport" });
    return McpManager.testConnection({
      name: b.name ?? "test",
      transport: b.transport,
      ...(b.command ? { command: b.command } : {}),
      ...(b.args ? { args: b.args } : {}),
      ...(b.url ? { url: b.url } : {}),
      ...(b.env ? { env: parseEnv(b.env) } : {}),
    });
  });

  // Kết nối lại 1 server — KHÔNG cần restart tiến trình
  app.post("/v1/mcp/:id/reconnect", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    if (!deps.mcp) return reply.code(503).send({ error: "MCP chưa bật (thiếu PENAI_MASTER_KEY)" });
    const { id } = req.params as { id: string };
    const rows = await listMcpServers(db, req.authCtx);
    const row = rows.find((s) => s.id === id);
    if (!row) return reply.code(404).send({ error: "MCP server không tồn tại" });
    const st = await deps.mcp.connectServer({
      id: row.id,
      workspaceId: req.authCtx.workspaceId,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: (row.args as string[]) ?? [],
      url: row.url,
      envEncrypted: row.envEncrypted,
      visibility: (row.visibility as "workspace" | "granted") ?? "workspace",
      oauthEncrypted: row.oauthEncrypted,
    });
    return { status: st };
  });
  app.post("/v1/mcp", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const b = req.body as {
      name?: string; transport?: "stdio" | "sse" | "http";
      command?: string; args?: string[]; url?: string; env?: string;
    };
    if (!b.name || !b.transport) return reply.code(400).send({ error: "Thiếu name/transport" });
    const s = await createMcpServer(db, req.authCtx, {
      name: b.name,
      transport: b.transport,
      ...(b.command ? { command: b.command } : {}),
      ...(b.args ? { args: b.args } : {}),
      ...(b.url ? { url: b.url } : {}),
      ...(b.env ? { envEncrypted: encryptSecret(b.env) } : {}),
    });
    // Kết nối ngay, không bắt restart
    let status: unknown = null;
    if (deps.mcp) {
      status = await deps.mcp.connectServer({
        id: s.id,
        workspaceId: req.authCtx.workspaceId,
        name: s.name,
        transport: s.transport,
        command: s.command,
        args: (s.args as string[]) ?? [],
        url: s.url,
        envEncrypted: s.envEncrypted,
        visibility: (s.visibility as "workspace" | "granted") ?? "workspace",
        oauthEncrypted: s.oauthEncrypted,
      });
    }
    return reply.code(201).send({ server: { id: s.id, name: s.name }, status });
  });
  app.delete("/v1/mcp/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteMcpServer(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "MCP server không tồn tại" });
    await deps.mcp?.removeServer(id);
    return { deleted: true };
  });

  // Phạm vi MCP server: workspace (mọi agent) | granted (chỉ agent được cấp)
  app.post("/v1/mcp/:id/visibility", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { visibility?: string };
    if (b?.visibility !== "workspace" && b?.visibility !== "granted") {
      return reply.code(400).send({ error: "visibility phải là workspace | granted" });
    }
    const ok = await setMcpVisibility(db, req.authCtx, id, b.visibility);
    if (!ok) return reply.code(404).send({ error: "MCP server không tồn tại" });
    // đổi phạm vi có hiệu lực ngay ở lượt chat sau (access query mỗi lượt),
    // nhưng cần reconnect để visibility mới gắn vào tool đã đăng ký
    const rows = await listMcpServers(db, req.authCtx);
    const row = rows.find((s) => s.id === id);
    if (row && deps.mcp) {
      await deps.mcp.connectServer({
        id: row.id,
        workspaceId: req.authCtx.workspaceId,
        name: row.name,
        transport: row.transport,
        command: row.command,
        args: (row.args as string[]) ?? [],
        url: row.url,
        envEncrypted: row.envEncrypted,
        visibility: b.visibility,
        oauthEncrypted: row.oauthEncrypted,
      });
    }
    return { updated: true };
  });

  // Grant / revoke MCP server cho agent (kèm tool_allow lọc từng tool, [] = mọi tool)
  app.post("/v1/mcp/:id/grants/agent", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { agentId?: string; toolAllow?: string[] };
    if (!b?.agentId) return reply.code(400).send({ error: "Thiếu agentId" });
    await grantMcpToAgent(db, req.authCtx, id, b.agentId, {
      ...(Array.isArray(b.toolAllow) ? { toolAllow: b.toolAllow } : {}),
      grantedBy: req.authCtx.userId,
    });
    return { granted: true };
  });
  app.delete("/v1/mcp/:id/grants/agent/:agentId", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id, agentId } = req.params as { id: string; agentId: string };
    const ok = await revokeMcpFromAgent(db, req.authCtx, id, agentId);
    return { revoked: ok };
  });

  // Danh sách MCP server kèm cờ granted cho 1 agent — cho dialog cấu hình agent
  app.get("/v1/agents/:id/mcp", async (req) => {
    const { id } = req.params as { id: string };
    const rows = await listMcpWithGrantStatus(db, req.authCtx, id);
    return {
      servers: rows.map((s) => ({
        id: s.id,
        name: s.name,
        transport: s.transport,
        visibility: s.visibility,
        enabled: s.enabled,
        granted: s.granted,
        toolAllow: s.toolAllow,
        tools: deps.mcp?.statusOf(s.id)?.tools ?? [],
      })),
    };
  });

  // OAuth callback: trang OAuth của MCP server redirect về đây kèm code+state.
  // Public (trình duyệt không gửi API key) — state sinh ngẫu nhiên là bằng chứng.
  app.get("/oauth/mcp/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const html = (title: string, body: string) =>
      reply.type("text/html; charset=utf-8").send(
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
          `<body style="font-family:system-ui;max-width:520px;margin:80px auto;text-align:center">` +
          `<h2>${title}</h2><p>${body}</p></body>`,
      );
    if (q.error) {
      return html("Đăng nhập MCP thất bại", `${q.error}: ${q.error_description ?? ""}`);
    }
    if (!q.code || !q.state || !deps.mcp) {
      return html("Thiếu tham số", "URL callback không hợp lệ (thiếu code/state).");
    }
    try {
      const st = await deps.mcp.completeOauth(q.state, q.code);
      if (!st) return html("Phiên không hợp lệ", "state không khớp — hãy bấm Đăng nhập lại trong dashboard.");
      return st.connected
        ? html("Đăng nhập MCP thành công", `Server "${st.name}" đã kết nối, ${st.toolCount} tool. Đóng tab này và quay lại dashboard.`)
        : html("Đã lấy token nhưng kết nối lỗi", st.error ?? "không rõ lỗi");
    } catch (err) {
      return html("Đăng nhập MCP thất bại", (err as Error).message);
    }
  });

  // Chính sách người dùng của MCP server: all (mọi user đã pair) | granted
  app.post("/v1/mcp/:id/user-policy", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { userPolicy?: string };
    if (b?.userPolicy !== "all" && b?.userPolicy !== "granted") {
      return reply.code(400).send({ error: "userPolicy phải là all | granted" });
    }
    const ok = await setMcpUserPolicy(db, req.authCtx, id, b.userPolicy);
    if (!ok) return reply.code(404).send({ error: "MCP server không tồn tại" });
    return { updated: true };
  });

  // Grant MCP theo NGƯỜI DÙNG CUỐI (userKey = "<kind>-<senderId>", xem contacts)
  app.get("/v1/mcp/:id/grants/users", async (req) => {
    const { id } = req.params as { id: string };
    return { grants: await listMcpUserGrants(db, req.authCtx, id) };
  });
  app.post("/v1/mcp/:id/grants/user", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const b = req.body as {
      userKey?: string;
      enabled?: boolean;
      toolAllow?: string[];
      toolDeny?: string[];
    };
    if (!b?.userKey?.trim()) return reply.code(400).send({ error: "Thiếu userKey" });
    await upsertMcpUserGrant(db, req.authCtx, id, b.userKey.trim(), {
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      ...(Array.isArray(b.toolAllow) ? { toolAllow: b.toolAllow } : {}),
      ...(Array.isArray(b.toolDeny) ? { toolDeny: b.toolDeny } : {}),
      grantedBy: req.authCtx.userId,
    });
    return { granted: true };
  });
  // userKey chứa ký tự tùy nền tảng → nhận qua query để khỏi lo URL-encode path
  app.delete("/v1/mcp/:id/grants/user", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const q = req.query as { userKey?: string };
    if (!q?.userKey) return reply.code(400).send({ error: "Thiếu userKey" });
    const ok = await revokeMcpUserGrant(db, req.authCtx, id, q.userKey);
    return { revoked: ok };
  });

  // ===== Link file công khai (tool publish_file) =====
  // Public — token 256-bit ngẫu nhiên (chỉ lưu SHA-256) là bằng chứng truy cập.
  app.get("/f/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
      return reply.code(404).send({ error: "Link không hợp lệ" });
    }
    const hash = createHash("sha256").update(token).digest("hex");
    const row = await getPublishedFileByHash(db, hash);
    if (!row || row.revoked) return reply.code(404).send({ error: "Link không tồn tại" });
    if (row.expiresAt.getTime() < Date.now()) {
      return reply.code(410).send({ error: "Link đã hết hạn" });
    }
    // File phải nằm trong vùng dữ liệu + không symlink escape (fail-closed)
    const dataRoot = resolve(deps.config.dataDir);
    const abs = resolve(row.absPath);
    if (abs !== dataRoot && !abs.startsWith(dataRoot + sep)) {
      return reply.code(404).send({ error: "Link không tồn tại" });
    }
    try {
      await assertRealPathInside(abs, [dataRoot], "vùng dữ liệu");
    } catch {
      return reply.code(404).send({ error: "Link không tồn tại" });
    }
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return reply.code(404).send({ error: "File không còn tồn tại" });
    if (info.size > UPLOAD_FILE_MAX_BYTES) {
      return reply.code(413).send({ error: "File quá lớn" });
    }
    const buf = await fsReadFile(abs);
    // Chỉ inline loại an toàn; còn lại ép tải về. sandbox CSP + nosniff để
    // file public (cùng origin dashboard) không thể chạy script đánh cắp key.
    const ct = row.contentType || "application/octet-stream";
    const inlineOk =
      ct.startsWith("image/") || ct.startsWith("video/") || ct.startsWith("audio/") ||
      ct === "application/pdf" || ct.startsWith("text/plain") || ct === "application/json";
    const asciiName = row.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
    return reply
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox")
      .header("cache-control", "private, max-age=60")
      .header(
        "content-disposition",
        `${inlineOk ? "inline" : "attachment"}; filename="${asciiName}"`,
      )
      .type(ct)
      .send(buf);
  });

  // Quản trị link công khai: liệt kê + thu hồi
  app.get("/v1/files/published", async (req) => {
    const rows = await listPublishedFiles(db, req.authCtx);
    return {
      files: rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        absPath: r.absPath,
        contentType: r.contentType,
        createdBy: r.createdBy,
        expiresAt: r.expiresAt,
        revoked: r.revoked,
        createdAt: r.createdAt,
      })),
    };
  });
  app.delete("/v1/files/published/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await revokePublishedFile(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Link không tồn tại" });
    return { revoked: true };
  });

  // ===== Memory =====
  app.get("/v1/workspace-memories", async (req) => {
    const q = req.query as { search?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const search = q.search?.trim();
    const rows = search
      ? await searchWorkspaceSemanticMemories(db, req.authCtx, search, limit)
      : await listWorkspaceSemanticMemories(db, req.authCtx, limit);
    return { memories: rows };
  });

  app.post("/v1/workspace-memories", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const parsed = CreateWorkspaceMemoryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const memory = await addWorkspaceSemanticMemory(db, req.authCtx, parsed.data);
    if (!memory) return reply.code(409).send({ error: "Kiến thức workspace này đã tồn tại" });
    await recordAudit(db, req.authCtx, "workspace_memory.create", {
      id: memory.id,
      importance: memory.importance,
      pinned: memory.pinned,
    });
    return reply.code(201).send({ memory });
  });

  app.patch("/v1/workspace-memories/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const parsed = UpdateWorkspaceMemoryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    try {
      const memory = await updateWorkspaceSemanticMemory(db, req.authCtx, id, parsed.data);
      if (!memory) return reply.code(404).send({ error: "Workspace Semantic không tồn tại" });
      await recordAudit(db, req.authCtx, "workspace_memory.update", {
        id,
        fields: Object.keys(parsed.data),
      });
      return { memory };
    } catch (err) {
      if (databaseErrorCode(err) === "23505") {
        return reply.code(409).send({ error: "Kiến thức workspace này đã tồn tại" });
      }
      throw err;
    }
  });

  app.delete("/v1/workspace-memories/:id", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteWorkspaceSemanticMemory(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Workspace Semantic không tồn tại" });
    await recordAudit(db, req.authCtx, "workspace_memory.delete", { id });
    return { deleted: true };
  });

  app.get("/v1/agents/:key/memories", async (req, reply) => {
    const { key } = req.params as { key: string };
    const q = req.query as { userKey?: string; search?: string; limit?: string };
    const agent = await getAgentByKey(db, req.authCtx, key);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const limit = Math.min(Number(q.limit) || 100, 500);
    const rows = q.search
      ? await searchMemories(db, req.authCtx, agent.id, q.search, limit, q.userKey)
      : await listMemories(db, req.authCtx, agent.id, limit, q.userKey);
    return {
      memories: rows,
      userKeys: await listMemoryUserKeys(db, req.authCtx, agent.id),
    };
  });

  app.post("/v1/agents/:key/memories", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { key } = req.params as { key: string };
    const agent = await getAgentByKey(db, req.authCtx, key);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const body = req.body as {
      content?: string;
      tier?: string;
      importance?: number;
      userKey?: string;
      pinned?: boolean;
    };
    if (!body.content) return reply.code(400).send({ error: "Thiếu content" });
    const m = await addMemory(db, req.authCtx, {
      agentId: agent.id,
      tier: body.tier === "episodic" ? "episodic" : "semantic",
      content: body.content,
      ...(typeof body.importance === "number" ? { importance: body.importance } : {}),
      ...(body.userKey ? { userKey: body.userKey } : {}),
      ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
    });
    if (!m) return reply.code(409).send({ error: "Ghi nhớ này đã tồn tại (trùng nội dung)" });
    return reply.code(201).send({ memory: m });
  });

  app.patch("/v1/memories/:id", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const b = req.body as { content?: string; importance?: number; pinned?: boolean };
    const m = await updateMemory(db, req.authCtx, id, b);
    if (!m) return reply.code(404).send({ error: "Memory không tồn tại / không có gì để sửa" });
    return { memory: m };
  });

  app.delete("/v1/memories/:id", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteMemory(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "Memory không tồn tại" });
    return { deleted: true };
  });

  // Dọn ghi nhớ episodic cũ, ít quan trọng, chưa ghim
  app.post("/v1/agents/:key/memories/prune", async (req, reply) => {
    if (!requireRole(req, reply, "ws_admin")) return;
    const { key } = req.params as { key: string };
    const agent = await getAgentByKey(db, req.authCtx, key);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const b = req.body as { olderThanDays?: number; maxImportance?: number };
    const removed = await pruneMemories(db, req.authCtx, {
      agentId: agent.id,
      olderThanDays: b?.olderThanDays ?? 30,
      ...(typeof b?.maxImportance === "number" ? { maxImportance: b.maxImportance } : {}),
    });
    return { removed };
  });

  // Consolidation: tóm tắt 1 session → lưu memory episodic (dùng LLM của agent).
  // Logic chung với MemoryWorker (worker nền tự làm việc này định kỳ).
  app.post("/v1/sessions/:id/consolidate", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const session = await getSession(db, req.authCtx, id);
    if (!session) return reply.code(404).send({ error: "Session không tồn tại" });
    const agent = await getAgentById(db, req.authCtx, session.agentId);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const r = await consolidateSession(deps, req.authCtx, id, agent);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    if (!r.memory) return { memory: null, note: r.note };
    return { memory: r.memory };
  });

  // ===== Memory documents (file ghi nhớ MEMORY.md / memory/*.md) =====
  app.get("/v1/agents/:key/memory-docs", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { key } = req.params as { key: string };
    const agent = await getAgentByKey(db, req.authCtx, key);
    if (!agent) return reply.code(404).send({ error: "Agent không tồn tại" });
    const q = req.query as { userKey?: string };
    const docs = await listMemoryDocs(db, req.authCtx, agent.id, q.userKey);
    return { docs };
  });

  app.get("/v1/memory-docs/:id", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const doc = await getMemoryDocById(db, req.authCtx, id);
    if (!doc) return reply.code(404).send({ error: "File ghi nhớ không tồn tại" });
    return { doc };
  });

  app.delete("/v1/memory-docs/:id", async (req, reply) => {
    if (!requireRole(req, reply, "operator")) return;
    const { id } = req.params as { id: string };
    const ok = await deleteMemoryDocById(db, req.authCtx, id);
    if (!ok) return reply.code(404).send({ error: "File ghi nhớ không tồn tại" });
    return { deleted: true };
  });

  // ===== Chat =====
  app.post("/v1/chat", async (req, reply) => {
    if (!requireChat(req, reply)) return;
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    const { sessionId, message, stream } = parsed.data;
    const files: WebAttachmentIn[] = parsed.data.files ?? [];
    if (!message.trim() && !files.length) {
      return reply.code(400).send({ error: "Nhập tin nhắn hoặc đính kèm file" });
    }

    // Usage cap: chặn nếu workspace vượt hạn mức token tháng
    if (await isOverCap(db, req.authCtx.workspaceId)) {
      return reply.code(429).send({ error: "Đã vượt hạn mức token tháng này" });
    }

    const session = await getSession(db, req.authCtx, sessionId);
    if (!session) {
      return reply.code(404).send({ error: "Session không tồn tại" });
    }
    const agent = await getAgentById(db, req.authCtx, session.agentId);
    if (!agent) {
      return reply.code(404).send({ error: "Agent không tồn tại" });
    }
    const traceStart = performance.now();

    // Thư mục riêng của người dùng web (giống mỗi người trên Telegram) + file đính kèm
    const dirs = webDirs(deps.config.dataDir, req.authCtx);
    const inbound = await prepareWebInbound(dirs.userDir, sessionId, message, files);
    const collector = createOutboundCollector(dirs.userDir, dirs.sharedDir);

    const sse = (raw: import("node:http").ServerResponse, ev: unknown) =>
      raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    const startSse = () => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      return raw;
    };

    // Chỉ gửi file, chưa có yêu cầu → lưu + xác nhận, KHÔNG chạy LLM (giống kênh chat)
    const savedAll = [...inbound.savedImages, ...inbound.savedDocs];
    const hasSubstance = message.trim().length > 0 || inbound.userMessage.includes("[Nội dung file");
    if (!hasSubstance && savedAll.length) {
      const names = savedAll.map((s) => s.name).join(", ");
      const ack = `📎 Đã lưu: ${names}. Bạn muốn làm gì với chúng? Ví dụ: "tóm tắt file này", "làm hình sản phẩm từ ảnh này", "phân tích số liệu"...`;
      await queue.run(sessionId, async () => {
        await appendMessage(db, req.authCtx, sessionId, {
          role: "user",
          content: { kind: "text", text: `[Đã gửi ${savedAll.length} file: ${names}]` },
        });
        await appendMessage(db, req.authCtx, sessionId, {
          role: "assistant",
          content: { kind: "assistant", text: ack, toolCalls: [] },
        });
      });
      if (stream) {
        const raw = startSse();
        sse(raw, { type: "saved", files: inbound.savedOut });
        sse(raw, { type: "text_delta", text: ack });
        sse(raw, { type: "done", finalText: ack, iterations: 0, usage: { inputTokens: 0, outputTokens: 0 } });
        raw.write("data: [DONE]\n\n");
        raw.end();
        return;
      }
      return { finalText: ack, iterations: 0, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], saved: inbound.savedOut, files: [] };
    }

    let loopDeps;
    try {
      loopDeps = await buildLoopDeps(deps, req.authCtx, agent.provider, {
        ...agentOpts(agent),
        userKey: webUserKey(req.authCtx),
        // operator/ws_admin giữ quyền MCP như dashboard cũ; member chịu lớp user (fail-closed)
        skipUserMcpLayer: req.authCtx.role !== "member",
        attachFile: (p) => collector.attachFile(p),
        // Người đăng nhập Dashboard là người thật đang chat → khối "Người đang chat"
        ...(req.authInfo?.kind === "web" ? { person: { channelKind: "web", peerKind: "direct" as const } } : {}),
        // Tool đặt lịch (cron_*): tới giờ chạy bằng quyền hiện tại của người này,
        // kết quả thành phiên chat mới "⏰ <tên lịch>" của họ.
        cronOrigin: { kind: "web", deliver: true, userId: req.authCtx.userId },
      });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
    const effort = reasoningEffortOf(agent);
    const runInput = {
      ctx: req.authCtx,
      agent: {
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        maxIterations: agent.maxIterations,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
      sessionId,
      userMessage: inbound.userMessage,
      ...(inbound.userImages.length ? { userImages: inbound.userImages } : {}),
    };

    // Sau vòng lặp: gom file agent trả ra → mô tả cho UI + ghi marker vào lịch sử
    const finishFiles = async () => {
      const paths = await collector.finish();
      const out = await describeOutbound(paths, dirs);
      if (out.length) {
        await appendMessage(db, req.authCtx, sessionId, {
          role: "assistant",
          content: {
            kind: "assistant",
            text: `📎 Đã gửi file: ${out.map((f) => f.name).join(", ")}\n${filesMarker(out)}`,
            toolCalls: [],
          },
        }).catch(() => {});
      }
      return out;
    };

    if (stream) {
      // SSE — serialize per-session qua KeyedQueue
      const raw = startSse();
      let streamUsage = { inputTokens: 0, outputTokens: 0 };
      let streamIterations = 0;
      let streamError: string | null = null;
      if (inbound.savedOut.length) sse(raw, { type: "saved", files: inbound.savedOut });
      await queue.run(sessionId, async () => {
        await collector.begin();
        try {
          for await (const ev of runAgent(loopDeps, runInput)) {
            if (ev.type === "tool_result") collector.noteToolResult(ev.result);
            if (ev.type === "done") {
              streamUsage = ev.usage;
              streamIterations = ev.iterations;
            }
            if (ev.type === "error") streamError = ev.message;
            sse(raw, ev);
          }
          for (const f of await finishFiles()) sse(raw, { type: "file", ...f });
        } catch (err) {
          const ev: AgentEvent = {
            type: "error",
            message: (err as Error).message,
          };
          streamError = ev.message;
          sse(raw, ev);
        }
      });
      raw.write("data: [DONE]\n\n");
      raw.end();
      // Trace cho nhanh STREAM: truoc 0025 nhanh nay khong ghi gi nen bang
      // traces gan nhu rong (79 ban ghi/30 ngay) va khong giam sat duoc.
      recordTraceSafe(db, req.authCtx, {
        agentId: agent.id,
        sessionId,
        inputTokens: streamUsage.inputTokens,
        outputTokens: streamUsage.outputTokens,
        iterations: streamIterations,
        durationMs: Math.round(performance.now() - traceStart),
        source: "web",
        model: agent.model,
        provider: agent.provider,
        ...(streamError ? { error: String(streamError).slice(0, 500) } : {}),
      });
      return;
    }

    // Non-stream: gom event, trả JSON
    const events: AgentEvent[] = [];
    let outFiles: Awaited<ReturnType<typeof finishFiles>> = [];
    await queue.run(sessionId, async () => {
      await collector.begin();
      for await (const ev of runAgent(loopDeps, runInput)) {
        if (ev.type === "tool_result") collector.noteToolResult(ev.result);
        events.push(ev);
      }
      outFiles = await finishFiles();
    });
    const done = events.find((e) => e.type === "done");
    const error = events.find((e) => e.type === "error");
    // Tracing (không chặn phản hồi nếu lỗi ghi)
    await recordTrace(db, req.authCtx, {
      agentId: agent.id,
      sessionId,
      inputTokens: done?.type === "done" ? done.usage.inputTokens : 0,
      outputTokens: done?.type === "done" ? done.usage.outputTokens : 0,
      iterations: done?.type === "done" ? done.iterations : 0,
      durationMs: Math.round(performance.now() - traceStart),
      source: "web",
      model: agent.model,
      provider: agent.provider,
      ...(error?.type === "error" ? { error: error.message } : {}),
    }).catch(() => {});
    if (!done) {
      return reply
        .code(500)
        .send({ error: error?.type === "error" ? error.message : "Không có kết quả" });
    }
    return {
      finalText: done.finalText,
      iterations: done.iterations,
      usage: done.usage,
      toolCalls: events
        .filter((e) => e.type === "tool_call")
        .map((e) => ({ name: e.name, args: e.args })),
      saved: inbound.savedOut,
      files: outFiles,
    };
  });

  // Tải file trong thư mục chat của chính mình (+ shared; operator/ws_admin: cả workspace).
  // Cookie/API key xác thực; realpath chống symlink; html/svg ép tải về.
  app.get("/v1/chat/files", async (req, reply) => {
    if (!requireChat(req, reply)) return;
    const q = req.query as { p?: string };
    if (!q.p) return reply.code(400).send({ error: "Thiếu p" });
    const dirs = webDirs(deps.config.dataDir, req.authCtx);
    const abs = await resolveDownload(q.p, req.authCtx, dirs);
    if (!abs) return reply.code(404).send({ error: "File không tồn tại hoặc không được phép" });
    return sendDownload(req, reply, abs);
  });

  // ===== WebSocket RPC =====
  // Giao thức: tin đầu phải là {type:"connect", apiKey}. Sau đó
  // {id, method, params}. Server trả {id, result} hoặc {id, error};
  // với method "chat" trả nhiều {id, event:<AgentEvent>} rồi {id, done:true}.
  // Bọc trong plugin + await register để onRoute hook của ws được cài trước.
  app.register(async (fastify) => {
    await fastify.register(fastifyWebsocket);
    fastify.get("/ws", { websocket: true }, (socket: WsLike) => {
    let wsCtx: WorkspaceContext | null = null;
    const send = (o: unknown) => socket.send(JSON.stringify(o));

    socket.on("message", async (raw: Buffer) => {
      let m: { type?: string; apiKey?: string; id?: string; method?: string; params?: Record<string, unknown> };
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return send({ error: "JSON không hợp lệ" });
      }

      if (m.type === "connect") {
        const auth = m.apiKey ? await authenticateApiKey(db, m.apiKey) : null;
        if (!auth) return send({ type: "connect", ok: false, error: "API key sai" });
        wsCtx = { workspaceId: auth.workspaceId, userId: auth.userId, role: auth.role };
        return send({ type: "connect", ok: true, role: auth.role });
      }

      if (!wsCtx) return send({ id: m.id, error: "Chưa connect" });
      const id = m.id;
      const p = m.params ?? {};
      try {
        switch (m.method) {
          case "agents.list":
            return send({ id, result: { agents: await listAgents(db, wsCtx) } });
          case "sessions.list":
            return send({ id, result: { sessions: await listSessions(db, wsCtx) } });
          case "sessions.create": {
            if (!hasRole(wsCtx.role, "operator")) return send({ id, error: "Cần operator" });
            const agent = await getAgentByKey(db, wsCtx, String(p.agentKey));
            if (!agent) return send({ id, error: "Agent không tồn tại" });
            const s = await createSession(db, wsCtx, { agentId: agent.id });
            return send({ id, result: { session: s } });
          }
          case "chat": {
            if (!hasRole(wsCtx.role, "operator")) return send({ id, error: "Cần operator" });
            const sessionId = String(p.sessionId);
            const session = await getSession(db, wsCtx, sessionId);
            if (!session) return send({ id, error: "Session không tồn tại" });
            const agent = await getAgentById(db, wsCtx, session.agentId);
            if (!agent) return send({ id, error: "Agent không tồn tại" });
            const loopDeps = await buildLoopDeps(deps, wsCtx, agent.provider, agentOpts(agent));
            const ctx = wsCtx;
            await queue.run(sessionId, async () => {
              for await (const ev of runAgent(loopDeps, {
                ctx,
                agent: { systemPrompt: agent.systemPrompt, model: agent.model, maxIterations: agent.maxIterations },
                sessionId,
                userMessage: String(p.message),
              })) {
                send({ id, event: ev });
              }
            });
            return send({ id, done: true });
          }
          default:
            return send({ id, error: `Method không hỗ trợ: ${m.method}` });
        }
      } catch (err) {
        return send({ id, error: (err as Error).message });
      }
    });
    });
  });

  return app;
}
