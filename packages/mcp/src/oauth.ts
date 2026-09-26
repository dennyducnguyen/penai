import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Dữ liệu OAuth bền vững của 1 MCP server (lưu DB dạng JSON mã hóa):
 * client đã đăng ký DCR + tokens + PKCE verifier đang dở.
 */
export interface McpOauthSession {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export interface OauthProviderDeps {
  /** redirect_uri — trỏ về route callback của PenAI. */
  redirectUrl: string;
  /** state gắn với lần authorize này (map về serverId ở callback). */
  state: string;
  /** Session đã lưu (giải mã từ DB), null nếu chưa từng đăng nhập. */
  session: McpOauthSession | null;
  /** Ghi session xuống DB (mã hóa) — gọi mỗi khi SDK lưu client/token/verifier. */
  persist: (session: McpOauthSession) => Promise<void>;
  /** SDK yêu cầu đưa người dùng tới URL authorize — ta hiện link trong dashboard. */
  onRedirect: (authUrl: string) => void;
}

/**
 * OAuthClientProvider cho MCP SDK: SDK tự lo discovery (RFC 8414 / 9728),
 * đăng ký client động (DCR), PKCE và refresh token — ta chỉ lưu/đọc state.
 * Toàn bộ discovery + DCR + luồng đăng nhập + làm mới token dựa trên SDK,
 * không tự viết lại.
 */
export function createOauthProvider(deps: OauthProviderDeps): OAuthClientProvider {
  const session: McpOauthSession = { ...(deps.session ?? {}) };
  const save = () => deps.persist(session);
  return {
    get redirectUrl() {
      return deps.redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "PenAI",
        redirect_uris: [deps.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none", // public client + PKCE
      };
    },
    state: () => deps.state,
    clientInformation: () => session.clientInformation,
    saveClientInformation: async (info) => {
      session.clientInformation = info;
      await save();
    },
    tokens: () => session.tokens,
    saveTokens: async (tokens) => {
      session.tokens = tokens;
      await save();
    },
    saveCodeVerifier: async (v) => {
      session.codeVerifier = v;
      await save();
    },
    codeVerifier: () => {
      if (!session.codeVerifier) throw new Error("Chưa có PKCE verifier — hãy đăng nhập lại");
      return session.codeVerifier;
    },
    redirectToAuthorization: (url) => deps.onRedirect(url.toString()),
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "tokens") delete session.tokens;
      if (scope === "all" || scope === "client") delete session.clientInformation;
      if (scope === "all" || scope === "verifier") delete session.codeVerifier;
      await save();
    },
  };
}
