/** Vai trò trong 1 workspace (bộ phận). */
export type WorkspaceRole = "ws_admin" | "operator" | "viewer" | "member";

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["ws_admin", "operator", "viewer", "member"];

/** Nhãn tiếng Việt cho UI. */
export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  ws_admin: "Quản trị",
  operator: "Vận hành",
  viewer: "Chỉ xem",
  member: "Thành viên (chỉ chat)",
};

/** Vai trò cấp công ty. */
export type CompanyRole = "owner" | "admin" | "member";

/**
 * Ngữ cảnh workspace — BẮT BUỘC với mọi thao tác dữ liệu workspace-scoped.
 * Không có ctx → không truy cập được dữ liệu (fail-closed).
 */
export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

const ROLE_RANK: Record<WorkspaceRole, number> = {
  member: -1, // ngoài thang: chỉ chat với agent được gán, không đọc gì khác
  viewer: 0,
  operator: 1,
  ws_admin: 2,
};

/** role có đủ quyền tối thiểu `min` không. */
export function hasRole(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Được chat (tạo phiên + gửi tin) không: operator trở lên, hoặc member. */
export function canChat(role: WorkspaceRole): boolean {
  return role === "member" || hasRole(role, "operator");
}
