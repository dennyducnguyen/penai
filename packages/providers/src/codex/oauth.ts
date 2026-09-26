import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Public client của OpenAI Codex CLI — chuẩn OAuth 2.0 + PKCE
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_SCOPE = "openid profile email offline_access";
export const DEFAULT_AUTH_FILE = ".local/codex-auth.json";

export interface CodexAuth {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  email?: string;
  /** epoch ms */
  expiresAt: number;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  return `${CODEX_ISSUER}/oauth/authorize?${q.toString()}`;
}

/** Decode payload JWT (không verify chữ ký — chỉ đọc claim). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("JWT không hợp lệ");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function authFromTokenResponse(data: {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in?: number;
}): CodexAuth {
  const payload = decodeJwtPayload(data.id_token);
  const authClaim = payload["https://api.openai.com/auth"] as
    | { chatgpt_account_id?: string }
    | undefined;
  const accountId = authClaim?.chatgpt_account_id;
  if (!accountId) {
    throw new Error(
      "id_token không có chatgpt_account_id — tài khoản có gói ChatGPT hợp lệ chưa?",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    accountId,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

async function tokenRequest(params: Record<string, string>): Promise<CodexAuth> {
  const res = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token request thất bại (${res.status}): ${text}`);
  }
  return authFromTokenResponse(
    (await res.json()) as Parameters<typeof authFromTokenResponse>[0],
  );
}

export function exchangeCode(code: string, verifier: string): Promise<CodexAuth> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  });
}

export function refreshAuth(auth: CodexAuth): Promise<CodexAuth> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: "openid profile email",
  });
}

export function loadAuth(file = DEFAULT_AUTH_FILE): CodexAuth | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CodexAuth;
  } catch {
    return null;
  }
}

export function saveAuth(auth: CodexAuth, file = DEFAULT_AUTH_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(auth, null, 2), "utf8");
}
