import { describe, expect, it } from "vitest";
import { createOauthProvider, type McpOauthSession } from "../src/oauth.js";

const REDIRECT = "http://127.0.0.1:18800/oauth/mcp/callback";

describe("MCP OAuth provider", () => {
  it("lưu client/token/verifier qua persist, đọc lại được", async () => {
    let saved: McpOauthSession | null = null;
    const p = createOauthProvider({
      redirectUrl: REDIRECT,
      state: "state-1",
      session: null,
      persist: async (s) => {
        saved = structuredClone(s);
      },
      onRedirect: () => {},
    });

    expect(p.clientMetadata.redirect_uris).toEqual([REDIRECT]);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
    expect(await p.state!()).toBe("state-1");
    expect(await p.clientInformation()).toBeUndefined();

    await p.saveClientInformation!({ client_id: "abc" });
    await p.saveCodeVerifier("pkce-xyz");
    await p.saveTokens({ access_token: "tok", token_type: "Bearer", refresh_token: "ref" });

    expect((await p.clientInformation())?.client_id).toBe("abc");
    expect(await p.codeVerifier()).toBe("pkce-xyz");
    expect((await p.tokens())?.access_token).toBe("tok");
    expect(saved).toEqual({
      clientInformation: { client_id: "abc" },
      codeVerifier: "pkce-xyz",
      tokens: { access_token: "tok", token_type: "Bearer", refresh_token: "ref" },
    });
  });

  it("nạp lại session đã lưu (mô phỏng đọc từ DB) — token dùng được ngay", async () => {
    const p = createOauthProvider({
      redirectUrl: REDIRECT,
      state: "state-2",
      session: {
        clientInformation: { client_id: "abc" },
        tokens: { access_token: "tok", token_type: "Bearer" },
      },
      persist: async () => {},
      onRedirect: () => {},
    });
    expect((await p.tokens())?.access_token).toBe("tok");
    expect((await p.clientInformation())?.client_id).toBe("abc");
  });

  it("redirectToAuthorization đưa URL ra ngoài (dashboard hiện link)", async () => {
    let url = "";
    const p = createOauthProvider({
      redirectUrl: REDIRECT,
      state: "s",
      session: null,
      persist: async () => {},
      onRedirect: (u) => {
        url = u;
      },
    });
    await p.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    expect(url).toBe("https://auth.example.com/authorize?x=1");
  });

  it("invalidateCredentials xóa đúng phần", async () => {
    let saved: McpOauthSession | null = null;
    const p = createOauthProvider({
      redirectUrl: REDIRECT,
      state: "s",
      session: {
        clientInformation: { client_id: "abc" },
        tokens: { access_token: "tok", token_type: "Bearer" },
        codeVerifier: "v",
      },
      persist: async (s) => {
        saved = structuredClone(s);
      },
      onRedirect: () => {},
    });
    await p.invalidateCredentials!("tokens");
    expect(await p.tokens()).toBeUndefined();
    expect((await p.clientInformation())?.client_id).toBe("abc");
    expect(saved).not.toBeNull();
    await p.invalidateCredentials!("all");
    expect(await p.clientInformation()).toBeUndefined();
  });

  it("thiếu PKCE verifier → báo lỗi rõ thay vì undefined", async () => {
    const p = createOauthProvider({
      redirectUrl: REDIRECT,
      state: "s",
      session: null,
      persist: async () => {},
      onRedirect: () => {},
    });
    await expect(async () => p.codeVerifier()).rejects.toThrow(/PKCE/);
  });
});
