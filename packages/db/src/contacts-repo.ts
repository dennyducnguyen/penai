import { eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { contactTags } from "./schema.js";

// ===== Hồ sơ contact, nhãn, chỉ dẫn cho AI theo từng người (0029) =====
// Hồ sơ gắn principal (danh tính gốc của một người); contact là danh tính của
// người đó trên MỘT kênh. Mọi truy vấn chạy trong withWorkspace → RLS lọc.

/** Trạng thái duyệt (pairing) của contact trên kênh của nó. */
export type PairingState = "da_duyet" | "cho_duyet" | "chua_duyet" | "khong_can" | "khong_ro";

export interface ContactTagRef {
  id: string;
  name: string;
  color: string;
}

export interface ContactTag extends ContactTagRef {
  aiInstructions: string;
  useInGroups: boolean;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactOverview {
  id: string;
  channelId: string | null;
  channelKind: string;
  channelName: string | null;
  externalId: string;
  /** Khóa người dùng dùng cho thư mục riêng, ghi nhớ, quyền MCP: "<kênh>-<id>". */
  userKey: string;
  /** Tên lấy từ hồ sơ trên kênh (Telegram/Zalo…) — người dùng tự đặt. */
  displayName: string | null;
  /** Tên quản trị viên đặt trong hồ sơ (ưu tiên hiển thị). */
  profileName: string | null;
  principalId: string | null;
  firstSeen: Date;
  lastSeen: Date;
  pairing: PairingState;
  hasInstructions: boolean;
  tags: ContactTagRef[];
}

export interface PrincipalProfile {
  principalId: string;
  displayName: string | null;
  addressAs: string | null;
  selfAddress: string | null;
  roleTitle: string | null;
  language: string | null;
  phone: string | null;
  email: string | null;
  shareContactInfo: boolean;
  customFields: Record<string, string>;
  aiInstructions: string;
  useInGroups: boolean;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Toàn bộ hồ sơ (PUT thay cả hồ sơ) — trường bỏ trống lưu NULL / mặc định. */
export interface PrincipalProfileInput {
  displayName?: string | null;
  addressAs?: string | null;
  selfAddress?: string | null;
  roleTitle?: string | null;
  language?: string | null;
  phone?: string | null;
  email?: string | null;
  shareContactInfo?: boolean;
  customFields?: Record<string, string>;
  aiInstructions?: string;
  useInGroups?: boolean;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));
/**
 * tx.execute trả timestamptz dạng chuỗi của PostgreSQL ("2026-09-26 15:01:01.36+00"),
 * không phải Date → chuẩn hóa để API luôn trả ISO (trình duyệt nào cũng đọc được).
 */
const toDate = (v: unknown): Date => {
  if (v instanceof Date) return v;
  const s = String(v ?? "");
  const d = new Date(s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(d.getTime()) ? new Date(s) : d;
};
/** id từ URL sai định dạng → coi như không tồn tại (tránh lỗi ép kiểu uuid của PostgreSQL). */
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const blankToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

function mapTag(r: Record<string, unknown>): ContactTag {
  return {
    id: r.id as string,
    name: r.name as string,
    color: (r.color as string) ?? "",
    aiInstructions: (r.ai_instructions as string) ?? "",
    useInGroups: Boolean(r.use_in_groups),
    memberCount: Number(r.member_count ?? 0),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

function mapProfile(r: Record<string, unknown>): PrincipalProfile {
  const cf = r.custom_fields;
  return {
    principalId: r.principal_id as string,
    displayName: str(r.display_name),
    addressAs: str(r.address_as),
    selfAddress: str(r.self_address),
    roleTitle: str(r.role_title),
    language: str(r.language),
    phone: str(r.phone),
    email: str(r.email),
    shareContactInfo: Boolean(r.share_contact_info),
    customFields:
      cf && typeof cf === "object" && !Array.isArray(cf)
        ? Object.fromEntries(Object.entries(cf as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    aiInstructions: (r.ai_instructions as string) ?? "",
    useInGroups: Boolean(r.use_in_groups),
    updatedBy: str(r.updated_by),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

function mapOverview(r: Record<string, unknown>): ContactOverview {
  const tags = Array.isArray(r.tags) ? (r.tags as ContactTagRef[]) : [];
  return {
    id: r.id as string,
    channelId: str(r.channel_id),
    channelKind: r.channel_kind as string,
    channelName: str(r.channel_name),
    externalId: r.external_id as string,
    userKey: `${r.channel_kind as string}-${r.external_id as string}`,
    displayName: str(r.display_name),
    profileName: str(r.profile_name),
    principalId: str(r.principal_id),
    firstSeen: toDate(r.first_seen),
    lastSeen: toDate(r.last_seen),
    pairing: r.pairing as PairingState,
    hasInstructions: Boolean(r.has_instructions),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color ?? "" })),
  };
}

async function queryOverview(db: Db, ctx: WorkspaceContext, contactId: string | null) {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT c.id, c.channel_id, c.channel_kind, c.external_id, c.display_name, c.principal_id,
             c.first_seen, c.last_seen,
             ch.name AS channel_name,
             pp.display_name AS profile_name,
             COALESCE(pp.ai_instructions, '') <> '' AS has_instructions,
             CASE
               WHEN c.channel_id IS NULL THEN 'khong_ro'
               WHEN ch.require_pairing = false THEN 'khong_can'
               WHEN EXISTS (
                 SELECT 1 FROM channel_pairings p
                 WHERE p.channel_id = c.channel_id AND p.external_user_id = c.external_id
                   AND p.status = 'approved'
               ) THEN 'da_duyet'
               WHEN EXISTS (
                 SELECT 1 FROM channel_pairings p
                 WHERE p.channel_id = c.channel_id AND p.external_user_id = c.external_id
                   AND p.status = 'pending' AND p.expires_at > now()
               ) THEN 'cho_duyet'
               ELSE 'chua_duyet'
             END AS pairing,
             COALESCE((
               SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)
                               ORDER BY lower(t.name))
               FROM principal_tags pt JOIN contact_tags t ON t.id = pt.tag_id
               WHERE pt.principal_id = c.principal_id
             ), '[]'::json) AS tags
      FROM contacts c
      LEFT JOIN channels ch ON ch.id = c.channel_id
      LEFT JOIN principal_profiles pp ON pp.principal_id = c.principal_id
      WHERE (${contactId}::uuid IS NULL OR c.id = ${contactId}::uuid)
      ORDER BY c.last_seen DESC
    `);
    return (res.rows as Array<Record<string, unknown>>).map(mapOverview);
  });
}

/** Danh sách contact kèm tên hồ sơ, nhãn, trạng thái duyệt — mới nhắn gần nhất trước. */
export async function listContactsOverview(db: Db, ctx: WorkspaceContext): Promise<ContactOverview[]> {
  return queryOverview(db, ctx, null);
}

export async function getContactOverview(
  db: Db,
  ctx: WorkspaceContext,
  contactId: string,
): Promise<ContactOverview | null> {
  if (!isUuid(contactId)) return null;
  return (await queryOverview(db, ctx, contactId))[0] ?? null;
}

/** Contact của một người gửi trên một kênh (vd để lượt chào sau duyệt biết principal). */
export async function findContactIdentity(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  externalId: string,
): Promise<{ contactId: string; principalId: string } | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id, principal_id FROM contacts
      WHERE channel_id = ${channelId} AND external_id = ${externalId} AND principal_id IS NOT NULL
      LIMIT 1
    `);
    const r = res.rows[0] as { id: string; principal_id: string } | undefined;
    return r ? { contactId: r.id, principalId: r.principal_id } : null;
  });
}

// ===== Hồ sơ =====

export async function getPrincipalProfile(
  db: Db,
  ctx: WorkspaceContext,
  principalId: string,
): Promise<PrincipalProfile | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`SELECT * FROM principal_profiles WHERE principal_id = ${principalId}`);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? mapProfile(r) : null;
  });
}

/**
 * Ghi toàn bộ hồ sơ của một người. Trả null khi principal không thuộc workspace
 * hiện tại (kiểm trong RLS — khóa ngoại tự nó không chặn gắn chéo workspace).
 */
export async function upsertPrincipalProfile(
  db: Db,
  ctx: WorkspaceContext,
  principalId: string,
  input: PrincipalProfileInput,
): Promise<PrincipalProfile | null> {
  // Ngữ cảnh hệ thống (kênh chat) dùng workspaceId làm userId — không phải user thật.
  const updatedBy = ctx.userId && ctx.userId !== ctx.workspaceId ? ctx.userId : null;
  return withWorkspace(db, ctx, async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM principals WHERE id = ${principalId}`);
    if (!owner.rows.length) return null;
    const res = await tx.execute(sql`
      INSERT INTO principal_profiles (
        principal_id, workspace_id, display_name, address_as, self_address, role_title,
        language, phone, email, share_contact_info, custom_fields, ai_instructions,
        use_in_groups, updated_by
      ) VALUES (
        ${principalId}, ${ctx.workspaceId}, ${blankToNull(input.displayName)},
        ${blankToNull(input.addressAs)}, ${blankToNull(input.selfAddress)},
        ${blankToNull(input.roleTitle)}, ${blankToNull(input.language)},
        ${blankToNull(input.phone)}, ${blankToNull(input.email)},
        ${input.shareContactInfo === true}, ${JSON.stringify(input.customFields ?? {})}::jsonb,
        ${(input.aiInstructions ?? "").trim()}, ${input.useInGroups === true}, ${updatedBy}
      )
      ON CONFLICT (principal_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        address_as = EXCLUDED.address_as,
        self_address = EXCLUDED.self_address,
        role_title = EXCLUDED.role_title,
        language = EXCLUDED.language,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        share_contact_info = EXCLUDED.share_contact_info,
        custom_fields = EXCLUDED.custom_fields,
        ai_instructions = EXCLUDED.ai_instructions,
        use_in_groups = EXCLUDED.use_in_groups,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING *
    `);
    return mapProfile(res.rows[0] as Record<string, unknown>);
  });
}

// ===== Nhãn =====

export async function listContactTags(db: Db, ctx: WorkspaceContext): Promise<ContactTag[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT t.*, (SELECT count(*) FROM principal_tags pt WHERE pt.tag_id = t.id) AS member_count
      FROM contact_tags t
      ORDER BY lower(t.name)
    `);
    return (res.rows as Array<Record<string, unknown>>).map(mapTag);
  });
}

export interface ContactTagInput {
  name: string;
  color?: string;
  aiInstructions?: string;
  useInGroups?: boolean;
}

/** Trùng tên (không phân biệt hoa thường) → lỗi PostgreSQL 23505. */
export async function createContactTag(
  db: Db,
  ctx: WorkspaceContext,
  input: ContactTagInput,
): Promise<ContactTag> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx
      .insert(contactTags)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name.trim(),
        color: input.color ?? "",
        aiInstructions: (input.aiInstructions ?? "").trim(),
        useInGroups: input.useInGroups === true,
      })
      .returning(),
  );
  const t = rows[0]!;
  return { ...t, memberCount: 0 };
}

export async function updateContactTag(
  db: Db,
  ctx: WorkspaceContext,
  id: string,
  patch: Partial<ContactTagInput>,
): Promise<ContactTag | null> {
  if (!isUuid(id)) return null;
  const set: Partial<typeof contactTags.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.aiInstructions !== undefined) set.aiInstructions = patch.aiInstructions.trim();
  if (patch.useInGroups !== undefined) set.useInGroups = patch.useInGroups;
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.update(contactTags).set(set).where(eq(contactTags.id, id)).returning(),
  );
  const t = rows[0];
  if (!t) return null;
  const tags = await listContactTags(db, ctx);
  return tags.find((x) => x.id === t.id) ?? { ...t, memberCount: 0 };
}

export async function deleteContactTag(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.delete(contactTags).where(eq(contactTags.id, id)).returning({ id: contactTags.id }),
  );
  return rows.length > 0;
}

/** Nhãn của một người, kèm chỉ dẫn (dùng cho ngữ cảnh AI). */
export async function listPrincipalTags(
  db: Db,
  ctx: WorkspaceContext,
  principalId: string,
): Promise<ContactTag[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT t.*, 0 AS member_count
      FROM principal_tags pt JOIN contact_tags t ON t.id = pt.tag_id
      WHERE pt.principal_id = ${principalId}
      ORDER BY lower(t.name)
    `);
    return (res.rows as Array<Record<string, unknown>>).map(mapTag);
  });
}

/**
 * Đặt lại toàn bộ nhãn của một người. Trả null khi principal hoặc một nhãn
 * không thuộc workspace hiện tại.
 */
export async function setPrincipalTags(
  db: Db,
  ctx: WorkspaceContext,
  principalId: string,
  tagIds: string[],
): Promise<ContactTag[] | null> {
  const ids = [...new Set(tagIds)];
  const ok = await withWorkspace(db, ctx, async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM principals WHERE id = ${principalId}`);
    if (!owner.rows.length) return false;
    if (ids.length) {
      const found = await tx.execute(sql`
        SELECT count(*)::int AS n FROM contact_tags
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      if (Number((found.rows[0] as { n: number }).n) !== ids.length) return false;
    }
    await tx.execute(sql`DELETE FROM principal_tags WHERE principal_id = ${principalId}`);
    for (const tagId of ids) {
      await tx.execute(sql`
        INSERT INTO principal_tags (workspace_id, principal_id, tag_id)
        VALUES (${ctx.workspaceId}, ${principalId}, ${tagId})
      `);
    }
    return true;
  });
  return ok ? listPrincipalTags(db, ctx, principalId) : null;
}

// ===== Dữ liệu liên quan một người (trang chi tiết contact) =====

export interface PersonMemoryRow {
  id: string;
  agentId: string;
  agentKey: string;
  agentName: string;
  tier: string;
  content: string;
  importance: number;
  pinned: boolean;
  createdAt: Date;
}

/** Ghi nhớ gắn ĐÚNG người này (mọi agent) — không lẫn ghi nhớ chung của agent. */
export async function listMemoriesForUserKey(
  db: Db,
  ctx: WorkspaceContext,
  userKey: string,
): Promise<PersonMemoryRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT m.id, m.agent_id, a.key AS agent_key, a.name AS agent_name, m.tier, m.content,
             m.importance, m.pinned, m.created_at
      FROM memories m JOIN agents a ON a.id = m.agent_id
      WHERE m.user_key = ${userKey}
      ORDER BY m.pinned DESC, m.importance DESC, m.created_at DESC
      LIMIT 200
    `);
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      agentId: r.agent_id as string,
      agentKey: r.agent_key as string,
      agentName: r.agent_name as string,
      tier: r.tier as string,
      content: r.content as string,
      importance: Number(r.importance),
      pinned: Boolean(r.pinned),
      createdAt: toDate(r.created_at),
    }));
  });
}

export interface PersonRelated {
  memoryDocs: Array<{ id: string; agentKey: string; agentName: string; path: string; bytes: number; updatedAt: Date }>;
  sessions: Array<{ id: string; title: string | null; agentKey: string | null; agentName: string | null; messageCount: number; lastActive: Date }>;
  vaultCollections: Array<{ id: string; name: string; slug: string; agentKey: string | null }>;
  mcpGrants: Array<{ serverName: string; enabled: boolean; toolAllow: string[]; toolDeny: string[] }>;
}

/** File ghi nhớ, hội thoại hiện tại, tài liệu riêng (Vault) và quyền MCP của một contact. */
export async function getPersonRelated(
  db: Db,
  ctx: WorkspaceContext,
  input: { userKey: string; principalId: string | null; channelId: string | null; externalId: string },
): Promise<PersonRelated> {
  return withWorkspace(db, ctx, async (tx) => {
    const docs = await tx.execute(sql`
      SELECT d.id, a.key AS agent_key, a.name AS agent_name, d.path,
             octet_length(d.content) AS bytes, d.updated_at
      FROM memory_documents d JOIN agents a ON a.id = d.agent_id
      WHERE d.user_key = ${input.userKey}
      ORDER BY d.updated_at DESC
      LIMIT 100
    `);
    // channel_sessions giữ 1 dòng/chat (lệnh /new trỏ sang session mới) → hội thoại hiện tại
    const sessions = input.channelId
      ? await tx.execute(sql`
          SELECT s.id, s.title, a.key AS agent_key, a.name AS agent_name, cs.last_active,
                 (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count
          FROM channel_sessions cs
          JOIN sessions s ON s.id = cs.session_id
          LEFT JOIN agents a ON a.id = s.agent_id
          WHERE cs.channel_id = ${input.channelId} AND cs.chat_key = ${input.externalId}
          ORDER BY cs.last_active DESC
        `)
      : { rows: [] };
    const vault = input.principalId
      ? await tx.execute(sql`
          SELECT c.id, c.name, c.slug, a.key AS agent_key
          FROM vault_collection_grants g
          JOIN vault_collections c ON c.id = g.collection_id
          LEFT JOIN agents a ON a.id = g.agent_id
          WHERE g.audience_type = 'principal' AND g.principal_id = ${input.principalId}
          ORDER BY c.name
        `)
      : { rows: [] };
    const mcp = await tx.execute(sql`
      SELECT s.name AS server_name, g.enabled, g.tool_allow, g.tool_deny
      FROM mcp_user_grants g JOIN mcp_servers s ON s.id = g.mcp_server_id
      WHERE g.user_key = ${input.userKey}
      ORDER BY s.name
    `);
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    return {
      memoryDocs: (docs.rows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        agentKey: r.agent_key as string,
        agentName: r.agent_name as string,
        path: r.path as string,
        bytes: Number(r.bytes),
        updatedAt: toDate(r.updated_at),
      })),
      sessions: (sessions.rows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        title: str(r.title),
        agentKey: str(r.agent_key),
        agentName: str(r.agent_name),
        messageCount: Number(r.message_count),
        lastActive: toDate(r.last_active),
      })),
      vaultCollections: (vault.rows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        slug: r.slug as string,
        agentKey: str(r.agent_key),
      })),
      mcpGrants: (mcp.rows as Array<Record<string, unknown>>).map((r) => ({
        serverName: r.server_name as string,
        enabled: Boolean(r.enabled),
        toolAllow: list(r.tool_allow),
        toolDeny: list(r.tool_deny),
      })),
    };
  });
}

// ===== Dữ liệu cho ngữ cảnh AI =====

export interface PersonContextData {
  /** Tên hiệu lực: tên quản trị viên đặt > tên trên kênh > tên principal. */
  displayName: string | null;
  /** Tên người dùng tự đặt trên kênh (chưa làm sạch — dữ liệu không tin cậy). */
  channelDisplayName: string | null;
  firstSeen: Date | null;
  profile: PrincipalProfile | null;
  tags: Array<{ name: string; aiInstructions: string; useInGroups: boolean }>;
}

export async function getPersonContextData(
  db: Db,
  ctx: WorkspaceContext,
  input: { principalId?: string; contactId?: string },
): Promise<PersonContextData | null> {
  if (!input.principalId && !input.contactId) return null;
  return withWorkspace(db, ctx, async (tx) => {
    let channelDisplayName: string | null = null;
    let firstSeen: Date | null = null;
    let principalId = input.principalId ?? null;
    if (input.contactId) {
      const c = await tx.execute(sql`
        SELECT display_name, first_seen, principal_id FROM contacts WHERE id = ${input.contactId}
      `);
      const r = c.rows[0] as { display_name: string | null; first_seen: unknown; principal_id: string | null } | undefined;
      if (r) {
        channelDisplayName = r.display_name;
        firstSeen = toDate(r.first_seen);
        principalId = principalId ?? r.principal_id;
      }
    }
    let principalName: string | null = null;
    let profile: PrincipalProfile | null = null;
    let tags: PersonContextData["tags"] = [];
    if (principalId) {
      const p = await tx.execute(sql`SELECT display_name, created_at FROM principals WHERE id = ${principalId}`);
      const pr = p.rows[0] as { display_name: string; created_at: unknown } | undefined;
      if (!pr && !input.contactId) return null;
      principalName = pr?.display_name ?? null;
      firstSeen = firstSeen ?? (pr ? toDate(pr.created_at) : null);
      const prof = await tx.execute(sql`SELECT * FROM principal_profiles WHERE principal_id = ${principalId}`);
      const row = prof.rows[0] as Record<string, unknown> | undefined;
      profile = row ? mapProfile(row) : null;
      const t = await tx.execute(sql`
        SELECT t.name, t.ai_instructions, t.use_in_groups
        FROM principal_tags pt JOIN contact_tags t ON t.id = pt.tag_id
        WHERE pt.principal_id = ${principalId}
        ORDER BY lower(t.name)
      `);
      tags = (t.rows as Array<Record<string, unknown>>).map((r) => ({
        name: r.name as string,
        aiInstructions: (r.ai_instructions as string) ?? "",
        useInGroups: Boolean(r.use_in_groups),
      }));
    }
    return {
      displayName: profile?.displayName ?? channelDisplayName ?? principalName,
      channelDisplayName: channelDisplayName ?? principalName,
      firstSeen,
      profile,
      tags,
    };
  });
}
