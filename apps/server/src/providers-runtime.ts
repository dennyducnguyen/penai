import { decryptSecret, logger } from "@penai/shared";
import { listEnabledLlmProviders, type DbHandle } from "@penai/db";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAICompatProvider,
  QwenProvider,
  type ProviderRegistry,
} from "@penai/providers";

export interface DbProviderInput {
  name: string;
  workspaceId: string;
  kind: string;
  baseUrl: string | null;
  apiKey: string;
}

/** Khởi tạo + đăng ký 1 provider từ DB vào registry (hot, không cần restart). */
export function registerDbProvider(reg: ProviderRegistry, p: DbProviderInput): void {
  if (p.kind === "qwen" || p.kind === "dashscope") {
    reg.registerRuntime(
      p.workspaceId,
      p.name,
      new QwenProvider(p.name, {
        ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
        apiKey: p.apiKey,
      }),
    );
    return;
  }
  if (p.kind === "gemini") {
    reg.registerRuntime(
      p.workspaceId,
      p.name,
      new GeminiProvider(p.name, { apiKey: p.apiKey }),
    );
    return;
  }
  if (p.kind === "anthropic") {
    reg.registerRuntime(
      p.workspaceId,
      p.name,
      new AnthropicProvider(p.name, {
        apiKey: p.apiKey,
        ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
      }),
    );
    return;
  }
  // OpenAI chính thức dùng base URL mặc định; endpoint tương thích khác có thể ghi đè.
  reg.registerRuntime(
    p.workspaceId,
    p.name,
    new OpenAICompatProvider(p.name, {
      ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
      apiKey: p.apiKey,
    }),
  );
}

/** Boot: nạp mọi provider enabled trong DB vào registry. */
export async function loadDbProviders(
  dbh: DbHandle,
  reg: ProviderRegistry,
): Promise<number> {
  let rows;
  try {
    rows = await listEnabledLlmProviders(dbh.db);
  } catch (err) {
    logger.warn(`Không đọc được providers DB: ${(err as Error).message}`);
    return 0;
  }
  let count = 0;
  for (const r of rows) {
    try {
      const apiKey = r.apiKeyEncrypted ? decryptSecret(r.apiKeyEncrypted) : "";
      registerDbProvider(reg, {
        name: r.name,
        workspaceId: r.workspaceId,
        kind: r.kind,
        baseUrl: r.baseUrl,
        apiKey,
      });
      count++;
    } catch (err) {
      logger.warn(`Provider DB "${r.name}" lỗi: ${(err as Error).message}`);
    }
  }
  if (count > 0) logger.info(`Đã nạp ${count} provider từ DB`);
  return count;
}
