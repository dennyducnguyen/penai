import type { ProviderConfig } from "@penai/shared";
import type { Provider } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { AnthropicProvider } from "./anthropic.js";
import { CodexProvider } from "./codex/provider.js";
import { AcpProvider } from "./acp/provider.js";
import { AntigravityProvider } from "./antigravity/provider.js";
import { ClaudeCodeProvider } from "./claude-code/provider.js";
import { GeminiProvider } from "./gemini.js";
import { QwenProvider } from "./dashscope.js";

export interface ProviderRegistry {
  get(name: string, workspaceId?: string): Provider;
  names(workspaceId?: string): string[];
  /** Nạp lại danh sách provider (config hot-reload). */
  reload(configs: Record<string, ProviderConfig>): void;
  /** Đăng ký provider runtime (tạo từ DB qua dashboard) — hot, không cần restart. */
  registerRuntime(workspaceId: string, name: string, provider: Provider): void;
  /** Gỡ provider runtime (xóa/tắt từ dashboard). */
  removeRuntime(workspaceId: string, name: string): void;
}

export function createProviderRegistry(
  initialConfigs: Record<string, ProviderConfig>,
): ProviderRegistry {
  let configs = initialConfigs;
  const cache = new Map<string, Provider>();
  const runtime = new Map<string, Provider>();
  return {
    names: (workspaceId?: string) => [
      ...new Set([
        ...Object.keys(configs),
        ...(workspaceId
          ? [...runtime.keys()]
              .filter((key) => key.startsWith(`${workspaceId}:`))
              .map((key) => key.slice(workspaceId.length + 1))
          : []),
      ]),
    ],
    reload(next: Record<string, ProviderConfig>): void {
      configs = next;
      cache.clear();
    },
    registerRuntime(workspaceId: string, name: string, provider: Provider): void {
      runtime.set(`${workspaceId}:${name}`, provider);
    },
    removeRuntime(workspaceId: string, name: string): void {
      runtime.delete(`${workspaceId}:${name}`);
    },
    get(name: string, workspaceId?: string): Provider {
      // provider config file ưu tiên hơn (tránh DB ghi đè codex/default)
      const cfg = configs[name];
      if (!cfg) {
        const rp = workspaceId ? runtime.get(`${workspaceId}:${name}`) : undefined;
        if (rp) return rp;
        throw new Error(
          `Provider "${name}" chưa được cấu hình (có: ${[
            ...new Set([
              ...Object.keys(configs),
              ...(workspaceId
                ? [...runtime.keys()]
                    .filter((key) => key.startsWith(`${workspaceId}:`))
                    .map((key) => key.slice(workspaceId.length + 1))
                : []),
            ]),
          ].join(", ") || "không có"})`,
        );
      }
      let p = cache.get(name);
      if (!p) {
        p = instantiate(name, cfg);
        cache.set(name, p);
      }
      return p;
    },
  };
}

function instantiate(name: string, cfg: ProviderConfig): Provider {
  if (cfg.kind === "openai") {
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) throw new Error(`Provider "${name}": thiếu env ${cfg.apiKeyEnv}`);
    return new OpenAICompatProvider(name, { apiKey });
  }
  if (cfg.kind === "gemini") {
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) throw new Error(`Provider "${name}": thiếu env ${cfg.apiKeyEnv}`);
    return new GeminiProvider(name, { apiKey });
  }
  if (cfg.kind === "qwen") {
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) throw new Error(`Provider "${name}": thiếu env ${cfg.apiKeyEnv}`);
    return new QwenProvider(name, {
      apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
  }
  if (cfg.kind === "openai-compat") {
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    return new OpenAICompatProvider(name, { baseURL: cfg.baseURL, apiKey });
  }
  if (cfg.kind === "codex") {
    return new CodexProvider(name, {
      authFile: cfg.authFile,
      accountsDir: cfg.accountsDir,
      modelRewrites: cfg.modelRewrites,
    });
  }
  if (cfg.kind === "acp") {
    return new AcpProvider(name, { command: cfg.command, args: cfg.args });
  }
  if (cfg.kind === "antigravity") {
    return new AntigravityProvider(name, {
      command: cfg.command,
      ...(cfg.scratchDir ? { scratchDir: cfg.scratchDir } : {}),
    });
  }
  if (cfg.kind === "claude-code") {
    return new ClaudeCodeProvider(name, {
      command: cfg.command,
      ...(cfg.scratchDir ? { scratchDir: cfg.scratchDir } : {}),
      ...(cfg.tokenFile ? { tokenFile: cfg.tokenFile } : {}),
    });
  }
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Provider "${name}": thiếu env ${cfg.apiKeyEnv}`);
  }
  return new AnthropicProvider(name, {
    apiKey,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  });
}
