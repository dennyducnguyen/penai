import { describe, expect, it } from "vitest";
import type { MemoryRow, WorkspaceSemanticMemoryRow } from "@penai/db";
import { mergeMemoryHits } from "../src/agent-runtime.js";

const agentHit = (
  id: string,
  content: string,
  rank: number,
  userKey: string | null = null,
) => ({ id, content, rank, userKey }) as MemoryRow & { rank: number };

const workspaceHit = (id: string, content: string, rank: number) =>
  ({ id, content, rank }) as WorkspaceSemanticMemoryRow & { rank: number };

describe("mergeMemoryHits", () => {
  it("ưu tiên bản agent khi nội dung trùng workspace", () => {
    const rows = mergeMemoryHits(
      [agentHit("agent-1", "Quy định chung", 0.5)],
      [workspaceHit("workspace-1", "  quy định chung  ", 0.9)],
      5,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "agent-1", source: "agent" });
  });

  it("boost nhẹ user > agent > workspace nhưng vẫn tôn trọng độ liên quan", () => {
    const rows = mergeMemoryHits(
      [agentHit("user-1", "riêng user", 0.5, "telegram-1"), agentHit("agent-1", "của agent", 0.5)],
      [workspaceHit("workspace-1", "của workspace", 0.7)],
      3,
    );
    expect(rows.map((r) => r.id)).toEqual(["workspace-1", "user-1", "agent-1"]);
  });

  it("giữ đúng giới hạn tổng sau khi hợp nhất", () => {
    const rows = mergeMemoryHits(
      [agentHit("agent-1", "A", 0.3), agentHit("agent-2", "B", 0.2)],
      [workspaceHit("workspace-1", "C", 0.4)],
      2,
    );
    expect(rows).toHaveLength(2);
  });
});
