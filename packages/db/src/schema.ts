import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const vector768 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
});

// ===== Company-level (KHÔNG workspace-scoped) =====

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  companyRole: text("company_role").notNull().default("member"),
  /** scrypt hash (0024). NULL = chưa đặt mật khẩu → không đăng nhập web được. */
  passwordHash: text("password_hash"),
  isActive: boolean("is_active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Phiên đăng nhập web (0024) — company-level, không RLS. Cookie giữ token thô, DB giữ sha256. */
export const webSessions = pgTable("web_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  userAgent: text("user_agent"),
  ip: text("ip"),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ===== Workspace-scoped (RLS bắt buộc — xem migrations/0001_init.sql) =====

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("workspace_members_pk").on(t.userId, t.workspaceId)],
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  role: text("role").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    maxIterations: integer("max_iterations").notNull().default(10),
    providerFallback: jsonb("provider_fallback").notNull().default([]),
    disabledTools: jsonb("disabled_tools").notNull().default([]),
    thinkingLevel: text("thinking_level").notNull().default("off"),
    /** Có nạp/tìm Workspace Semantic cho agent này hay không. */
    workspaceMemoryEnabled: boolean("workspace_memory_enabled").notNull().default(true),
    /** Agent được ghi vào thư viện file của chính nó (0028) — mặc định chỉ đọc. */
    libraryWritable: boolean("library_writable").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("agents_ws_key_uq").on(t.workspaceId, t.key)],
);

/** Member được chat với agent nào (0024). Role ws_admin/operator thấy mọi agent. */
export const agentUserGrants = pgTable(
  "agent_user_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("agent_user_grants_uq").on(t.workspaceId, t.agentId, t.userId)],
);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  title: text("title"),
  /** Người tạo phiên qua web (0024). NULL = API key / kênh chat / phiên cũ. */
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // system | user | assistant | tool
    content: jsonb("content").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("messages_session_seq_uq").on(t.sessionId, t.seq)],
);

// ===== Channels (0002) =====

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  tokenEncrypted: text("token_encrypted"),
  config: jsonb("config").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  requirePairing: boolean("require_pairing").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const channelPairings = pgTable(
  "channel_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    externalUserId: text("external_user_id"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("channel_pairings_code_uq").on(t.channelId, t.code)],
);

export const principals = pgTable(
  "principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull().default("contact"),
    displayName: text("display_name").notNull(),
    workspaceUserId: uuid("workspace_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    mergedIntoId: uuid("merged_into_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("principals_workspace_user_uq").on(t.workspaceId, t.workspaceUserId)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id").references(() => principals.id, { onDelete: "set null" }),
    channelKind: text("channel_kind").notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    approved: boolean("approved").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    firstSeen: timestamp("first_seen", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("contacts_legacy_uq").on(t.workspaceId, t.channelKind, t.externalId)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    externalChatId: text("external_chat_id").notNull(),
    peerKind: text("peer_kind").notNull().default("direct"),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("conversations_channel_chat_uq").on(t.channelId, t.externalChatId)],
);

// Danh sách quan sát Zalo Personal (0017) — chỉ metadata, không lưu nội dung
export const zaloObservedPeers = pgTable(
  "zalo_observed_peers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    chatKey: text("chat_key").notNull(),
    threadId: text("thread_id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    lastSenderId: text("last_sender_id").notNull(),
    lastSenderName: text("last_sender_name").notNull(),
    messageCount: integer("message_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("zalo_observed_uq").on(t.channelId, t.chatKey)],
);

export const traces = pgTable("traces", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("chat"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  iterations: integer("iterations").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
  /** Nguồn lượt chạy (0025): web | channel | api | cron | webhook | subagent. */
  source: text("source").notNull().default("web"),
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id),
  model: text("model").notNull().default(""),
  provider: text("provider").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageCaps = pgTable("usage_caps", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id).unique(),
  monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const hooks = pgTable("hooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  event: text("event").notNull(),
  matcher: text("matcher").notNull().default(".*"),
  url: text("url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentWebhooks = pgTable("agent_webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  secretEncrypted: text("secret_encrypted").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vaultSettings = pgTable("vault_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  chunkTokens: integer("chunk_tokens").notNull().default(800),
  chunkOverlapTokens: integer("chunk_overlap_tokens").notNull().default(100),
  contextTokens: integer("context_tokens").notNull().default(24000),
  retrievalLimit: integer("retrieval_limit").notNull().default(8),
  autoRetrieve: boolean("auto_retrieve").notNull().default(true),
  // Ngưỡng token để MỘT tài liệu được nạp nguyên văn (chế độ auto)
  fullDocTokens: integer("full_doc_tokens").notNull().default(16000),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vaultCollections = pgTable(
  "vault_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    // auto | always_full | search_only — xem migration 0023
    retrievalMode: text("retrieval_mode").notNull().default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vault_collections_slug_uq").on(t.workspaceId, t.slug)],
);

export const vaultDocuments = pgTable(
  "vault_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    collectionId: uuid("collection_id").notNull().references(() => vaultCollections.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull().default(""),
    indexStatus: text("index_status").notNull().default("pending"),
    indexError: text("index_error"),
    tokenCount: integer("token_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    indexVersion: integer("index_version").notNull().default(1),
    // Tên file gốc khi upload (null = soạn trực tiếp)
    sourceFile: text("source_file"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vault_slug_uq").on(t.workspaceId, t.slug)],
);

export const vaultCollectionGrants = pgTable("vault_collection_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  collectionId: uuid("collection_id").notNull().references(() => vaultCollections.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  audienceType: text("audience_type").notNull(),
  principalId: uuid("principal_id").references(() => principals.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vaultChunks = pgTable(
  "vault_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    collectionId: uuid("collection_id").notNull().references(() => vaultCollections.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => vaultDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    headingPath: text("heading_path").notNull().default(""),
    content: text("content").notNull(),
    searchText: text("search_text").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector768("embedding"),
    embeddingModel: text("embedding_model"),
    indexVersion: integer("index_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vault_chunks_document_ordinal_uq").on(t.documentId, t.ordinal)],
);

export const vaultIngestionJobs = pgTable("vault_ingestion_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  documentId: uuid("document_id").notNull().references(() => vaultDocuments.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  providerName: text("provider_name"),
  embeddingModel: text("embedding_model"),
  chunkTokens: integer("chunk_tokens").notNull(),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kgEntities = pgTable("kg_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("entity"),
  summary: text("summary").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kgRelations = pgTable("kg_relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  fromEntity: uuid("from_entity").notNull().references(() => kgEntities.id, { onDelete: "cascade" }),
  toEntity: uuid("to_entity").notNull().references(() => kgEntities.id, { onDelete: "cascade" }),
  relation: text("relation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    role: text("role").notNull().default("member"),
  },
  (t) => [uniqueIndex("team_members_pk").on(t.teamId, t.agentId)],
);

export const teamTasks = pgTable("team_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("todo"),
  claimedBy: uuid("claimed_by").references(() => agents.id, { onDelete: "set null" }),
  result: text("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentLinks = pgTable(
  "agent_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: uuid("to_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    mode: text("mode").notNull().default("sync"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_links_uq").on(t.fromAgentId, t.toAgentId)],
);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    visibility: text("visibility").notNull().default("workspace"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("skills_slug_uq").on(t.workspaceId, t.slug)],
);

// File đi kèm skill (scripts/, references/) — DB là nguồn chuẩn, materialize ra đĩa
export const skillFiles = pgTable(
  "skill_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentB64: text("content_b64").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skill_files_uq").on(t.workspaceId, t.skillId, t.path)],
);

// Snapshot phiên bản skill — xem lại + khôi phục
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    files: jsonb("files").notNull().default([]),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skill_versions_uq").on(t.workspaceId, t.skillId, t.version)],
);

export const skillAgentGrants = pgTable(
  "skill_agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    canManage: boolean("can_manage").notNull().default(false),
    grantedBy: text("granted_by").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_agent_grants_uq").on(t.workspaceId, t.skillId, t.agentId),
  ],
);

export const llmProviders = pgTable(
  "llm_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    baseUrl: text("base_url"),
    apiKeyEncrypted: text("api_key_encrypted"),
    defaultModel: text("default_model"),
    defaultEmbeddingModel: text("default_embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    isDefaultEmbedding: boolean("is_default_embedding").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("llm_providers_name_uq").on(t.workspaceId, t.name)],
);

export const customTools = pgTable(
  "custom_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    commandTemplate: text("command_template").notNull(),
    paramsSchema: jsonb("params_schema").notNull().default({}),
    envEncrypted: text("env_encrypted"),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("custom_tools_name_uq").on(t.workspaceId, t.name)],
);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    transport: text("transport").notNull(),
    command: text("command"),
    args: jsonb("args").notNull().default([]),
    url: text("url"),
    envEncrypted: text("env_encrypted"),
    // workspace = mọi agent dùng được | granted = chỉ agent được cấp
    visibility: text("visibility").notNull().default("workspace"),
    // all = mọi người dùng kênh đã pair | granted = chỉ user có grant enabled
    userPolicy: text("user_policy").notNull().default("all"),
    // OAuth session mã hóa (client DCR + tokens + PKCE verifier) cho http/sse
    oauthEncrypted: text("oauth_encrypted"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("mcp_servers_name_uq").on(t.workspaceId, t.name)],
);

export const mcpAgentGrants = pgTable(
  "mcp_agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolAllow: jsonb("tool_allow").notNull().default([]), // [] = mọi tool
    grantedBy: text("granted_by").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("mcp_agent_grants_uq").on(t.workspaceId, t.mcpServerId, t.agentId),
  ],
);

// Phân quyền MCP theo người dùng cuối trên kênh chat (0021).
// user_key = "<channel_kind>-<sender_id>" — trùng userKey của channels-runtime.
export const mcpUserGrants = pgTable(
  "mcp_user_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    userKey: text("user_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    toolAllow: jsonb("tool_allow").notNull().default([]), // [] = mọi tool
    toolDeny: jsonb("tool_deny").notNull().default([]), // deny luôn thắng
    grantedBy: text("granted_by").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("mcp_user_grants_uq").on(t.workspaceId, t.mcpServerId, t.userKey),
  ],
);

// Link công khai cho file workspace (tool publish_file, 0020).
export const publishedFiles = pgTable(
  "published_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    tokenHash: text("token_hash").notNull(), // sha256(token) hex
    absPath: text("abs_path").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    createdBy: text("created_by").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("published_files_token_uq").on(t.tokenHash)],
);

// Landing page HTML do agent tao/sua, route public chay trong CSP sandbox (0027).
export const landingPages = pgTable(
  "landing_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    html: text("html").notNull(),
    version: integer("version").notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("landing_pages_ws_slug_uq").on(t.workspaceId, t.slug)],
);

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  tier: text("tier").notNull(), // episodic | semantic
  content: text("content").notNull(),
  sourceSessionId: uuid("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
  importance: real("importance").notNull().default(0.5),
  embedding: jsonb("embedding"),
  /** null = ghi nhớ chung của agent; có giá trị = riêng người dùng kênh đó. */
  userKey: text("user_key"),
  pinned: boolean("pinned").notNull().default(false),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessed: timestamp("last_accessed", { withTimezone: true }),
  contentHash: text("content_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Semantic dùng chung trong workspace; agent có thể tắt bằng workspaceMemoryEnabled. */
export const workspaceSemanticMemories = pgTable(
  "workspace_semantic_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    content: text("content").notNull(),
    importance: real("importance").notNull().default(0.8),
    pinned: boolean("pinned").notNull().default(false),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessed: timestamp("last_accessed", { withTimezone: true }),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_semantic_memories_dedup_uq").on(t.workspaceId, t.contentHash),
  ],
);

/**
 * Memory dạng file: agent ghi MEMORY.md / memory/*.md bằng
 * write_file, bản sao lưu ở đây để memory_search (tsvector) và memory_get.
 */
export const memoryDocuments = pgTable("memory_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  /** null = ghi nhớ chung của agent; có giá trị = riêng người dùng kênh đó. */
  userKey: text("user_key"),
  path: text("path").notNull(),
  content: text("content").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const cronJobs = pgTable("cron_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("cron"),
  schedule: text("schedule").notNull(),
  prompt: text("prompt").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  nextRun: timestamp("next_run", { withTimezone: true }).notNull(),
  lastRun: timestamp("last_run", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const cronRuns = pgTable("cron_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  cronJobId: uuid("cron_job_id")
    .notNull()
    .references(() => cronJobs.id, { onDelete: "cascade" }),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull(),
  output: text("output"),
});


export const channelSessions = pgTable(
  "channel_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    chatKey: text("chat_key").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActive: timestamp("last_active", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("channel_sessions_uq").on(t.channelId, t.chatKey)],
);

// ===== API công khai (0025) — specs/spec-public-api-gateway.md =====

export const apiKeyPolicies = pgTable("api_key_policies", {
  apiKeyId: uuid("api_key_id")
    .primaryKey()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  /** null = dùng api.defaultModels trong config; mảng = allowlist tường minh. */
  models: jsonb("models").$type<string[] | null>(),
  agents: jsonb("agents").$type<string[] | null>(),
  rpm: integer("rpm"),
  maxConcurrent: integer("max_concurrent"),
  monthlyTokens: bigint("monthly_tokens", { mode: "number" }),
  paused: boolean("paused").notNull().default(false),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiUsageDaily = pgTable("api_usage_daily", {
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  apiKeyId: uuid("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  day: text("day").notNull(),
  model: text("model").notNull(),
  requests: integer("requests").notNull().default(0),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  images: integer("images").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  queuedMs: bigint("queued_ms", { mode: "number" }).notNull().default(0),
  durationMs: bigint("duration_ms", { mode: "number" }).notNull().default(0),
});

export const apiConversations = pgTable("api_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  apiKeyId: uuid("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiIdempotency = pgTable("api_idempotency", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  apiKeyId: uuid("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  idemKey: text("idem_key").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("running"),
  response: jsonb("response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const llmRouteState = pgTable("llm_route_state", {
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  provider: text("provider").notNull(),
  model: text("model").notNull().default(""),
  modality: text("modality").notNull().default("chat"),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  cooldownStreak: integer("cooldown_streak").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
