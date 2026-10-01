import { describe, expect, it } from "vitest";
import { parseCodexCallback, startLoginFlow } from "../src/codex/login-flow.js";

describe("đăng nhập ChatGPT — nhiều phiên cùng lúc (lớp học dùng chung tài khoản quản trị)", () => {
  it("parseCodexCallback tách code + state từ link localhost:1455, hoặc nhận riêng code", () => {
    expect(parseCodexCallback("http://localhost:1455/auth/callback?code=ac_1&scope=x&state=S1")).toEqual({
      code: "ac_1",
      state: "S1",
    });
    expect(parseCodexCallback("ac_only")).toEqual({ code: "ac_only" });
    expect(() => parseCodexCallback("http://localhost:1455/auth/callback?error=access_denied")).toThrow(/access_denied/);
    expect(() => parseCodexCallback("http://localhost:1455/auth/callback?state=S1")).toThrow(/code/);
  });

  it("hai phiên song song: phiên sau không lỗi dù cổng 1455 đã bận; mỗi phiên chỉ nhận link của chính nó", async () => {
    const a = startLoginFlow({ save: false, openBrowser: false, optionalListen: true });
    const b = startLoginFlow({ save: false, openBrowser: false, optionalListen: true });
    try {
      expect(a.state).not.toBe(b.state);
      expect(new URL(a.url).searchParams.get("state")).toBe(a.state);
      // Chờ một nhịp cho sự kiện lỗi cổng (EADDRINUSE) của phiên b nếu có
      await new Promise((r) => setTimeout(r, 50));
      let bFailed = false;
      b.done.catch(() => (bFailed = true));
      await new Promise((r) => setTimeout(r, 20));
      expect(bFailed).toBe(false);
      // Dán nhầm link của phiên a vào phiên b → báo state không khớp (không đổi code)
      expect(() => b.submit(`http://localhost:1455/auth/callback?code=x&state=${a.state}`)).toThrow(/state không khớp/);
    } finally {
      a.cancel();
      b.cancel();
    }
  });
});
