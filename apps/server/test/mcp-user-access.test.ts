import { describe, expect, it } from "vitest";
import type { McpUserAccessRow } from "@penai/db";
import { mergeMcpAccessLayers } from "../src/agent-runtime.js";

function row(over: Partial<McpUserAccessRow> = {}): McpUserAccessRow {
  return {
    serverId: "sv-1",
    userPolicy: "all",
    hasGrant: false,
    grantEnabled: false,
    toolAllow: [],
    toolDeny: [],
    ...over,
  };
}

const agentFull = () => new Map<string, Set<string> | null>([["sv-1", null]]);

describe("mergeMcpAccessLayers: quyền agent ∩ lớp quyền user", () => {
  it("user_policy=all, không có grant → giữ nguyên quyền agent", () => {
    const out = mergeMcpAccessLayers(agentFull(), [row()]);
    expect(out.get("sv-1")).toEqual({ allow: null });
  });

  it("user_policy=granted, không có grant → mất quyền server", () => {
    const out = mergeMcpAccessLayers(agentFull(), [row({ userPolicy: "granted" })]);
    expect(out.has("sv-1")).toBe(false);
  });

  it("user_policy=granted, có grant enabled → được dùng", () => {
    const out = mergeMcpAccessLayers(agentFull(), [
      row({ userPolicy: "granted", hasGrant: true, grantEnabled: true }),
    ]);
    expect(out.get("sv-1")).toEqual({ allow: null });
  });

  it("grant enabled=false là veto — kể cả khi user_policy=all", () => {
    const out = mergeMcpAccessLayers(agentFull(), [
      row({ hasGrant: true, grantEnabled: false }),
    ]);
    expect(out.has("sv-1")).toBe(false);
  });

  it("tool_allow của user thu hẹp quyền (giao với allow agent)", () => {
    // agent chỉ cho a,b — user chỉ cho b,c → còn b
    const agentAccess = new Map<string, Set<string> | null>([
      ["sv-1", new Set(["a", "b"])],
    ]);
    const out = mergeMcpAccessLayers(agentAccess, [
      row({ hasGrant: true, grantEnabled: true, toolAllow: ["b", "c"] }),
    ]);
    expect([...(out.get("sv-1")!.allow ?? [])]).toEqual(["b"]);
  });

  it("tool_deny của user được giữ để deny thắng lúc lọc", () => {
    const out = mergeMcpAccessLayers(agentFull(), [
      row({ hasGrant: true, grantEnabled: true, toolDeny: ["x"] }),
    ]);
    expect(out.get("sv-1")!.deny?.has("x")).toBe(true);
    expect(out.get("sv-1")!.allow).toBeNull();
  });

  it("server không nằm trong userRows (đã tắt) → loại", () => {
    const out = mergeMcpAccessLayers(agentFull(), []);
    expect(out.size).toBe(0);
  });
});
