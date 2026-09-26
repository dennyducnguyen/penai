import { loadConfig, watchConfig, logger } from "@penai/shared";
import { createDb, saveMcpOauth } from "@penai/db";
import { createProviderRegistry } from "@penai/providers";
import { ProviderGate } from "@penai/core";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "./app.js";
import { startChannels } from "./channels-runtime.js";
import { loadDbProviders } from "./providers-runtime.js";
import { CronRunner } from "./cron-runner.js";
import { MemoryWorker } from "./memory-worker.js";
import { McpManager } from "./mcp-manager.js";
import { syncAllSkillsToDisk } from "./skills-fs.js";

try {
  process.loadEnvFile(".env");
} catch {
  // không có .env → dùng env hệ thống
}

const config = loadConfig();
const db = createDb(config.databaseUrl);
const providers = createProviderRegistry(config.providers);
const tools = createDefaultToolRegistry();

// Tran dong thoi theo provider, DUNG CHUNG cho moi loi vao (API cong khai,
// Dashboard, kenh chat, cron, subagent). Do tren VPS 12/09/2026: moi tien
// trinh claude/agy chiem ~220 MB RSS trong khi may chi con ~1,1 GB trong,
// nen cliTotal mac dinh la 2. Xem specs/spec-public-api-gateway.md muc 7.
const providerGate = new ProviderGate({
  concurrency: config.api.queue.concurrency,
  cliTotal: config.api.queue.cliTotal,
  max: config.api.queue.max,
  waitMs: config.api.queue.waitMs,
});

// MCP: kết nối các server đã cấu hình (cung cấp tool cho agent).
// OAuth redirect về chính server này (PENAI_PUBLIC_URL đè khi chạy sau reverse proxy).
const publicBase =
  process.env.PENAI_PUBLIC_URL?.replace(/\/$/, "") ??
  `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
// PENAI_MCP_OAUTH_REDIRECT: đè redirect_uri OAuth MCP. Dùng cho server (vd Canva)
// CHỈ chấp nhận redirect loopback với client chưa được duyệt — admin đăng nhập
// qua SSH tunnel (ssh -L 18800:127.0.0.1:18800 ...) đúng 1 lần, refresh token
// về sau chạy server-side không cần redirect. Bỏ env này khi Canva duyệt waitlist.
const mcp = new McpManager({
  oauthRedirectUrl:
    process.env.PENAI_MCP_OAUTH_REDIRECT?.replace(/\/$/, "") ??
    `${publicBase}/oauth/mcp/callback`,
  persistOauth: async (serverId, workspaceId, encrypted) => {
    await saveMcpOauth(
      db.db,
      { workspaceId, userId: workspaceId, role: "ws_admin" },
      serverId,
      encrypted,
    );
  },
});
if (process.env.PENAI_MASTER_KEY) {
  try {
    await mcp.start(db);
  } catch (err) {
    logger.warn(`MCP start lỗi: ${(err as Error).message}`);
  }
}

// Providers cấu hình trong DB (dashboard) — cần master key để giải mã api key
if (process.env.PENAI_MASTER_KEY) {
  await loadDbProviders(db, providers);
}

// Skills: dựng lại thư mục skill (SKILL.md + scripts/) ra đĩa từ DB
try {
  await syncAllSkillsToDisk(db, config.dataDir);
} catch (err) {
  logger.warn(`Sync skills ra đĩa lỗi: ${(err as Error).message}`);
}

const app = buildApp({ db, providers, tools, config, mcp, gate: providerGate });

await app.listen({ port: config.port, host: config.host });
logger.info(`PenAI server chạy tại http://${config.host}:${config.port}`);

// Khởi động các channel (Telegram...) đã cấu hình + enabled trong DB
let channelManager: Awaited<ReturnType<typeof startChannels>> | null = null;
if (process.env.PENAI_MASTER_KEY) {
  try {
    channelManager = await startChannels({ db, providers, tools, config, mcp, gate: providerGate });
  } catch (err) {
    logger.error(`Khởi động channels lỗi: ${(err as Error).message}`);
  }
} else {
  logger.warn("Thiếu PENAI_MASTER_KEY — bỏ qua channels (không giải mã được token)");
}

// Cron runner (agent chạy theo lịch + heartbeat)
const cronRunner = new CronRunner({ db, providers, tools, config, mcp, gate: providerGate });
cronRunner.start();
logger.info("Cron runner đã khởi động");

// Memory worker: tự tóm tắt session đã nguội thành memory episodic
const memoryWorker = new MemoryWorker({ db, providers, tools, config, mcp, gate: providerGate });
memoryWorker.start();

// Config hot-reload: nạp lại providers, trần đồng thời và thương hiệu khi file cấu hình đổi
const stopWatch = await watchConfig((next) => {
  providers.reload(next.providers);
  // Thương hiệu đọc lúc phục vụ trang → đổi trong file cấu hình là tải lại trang thấy ngay.
  config.branding = next.branding;
  providerGate.reconfigure({
    concurrency: next.api.queue.concurrency,
    cliTotal: next.api.queue.cliTotal,
    max: next.api.queue.max,
    waitMs: next.api.queue.waitMs,
  });
  logger.info("Đã nạp lại config (providers + trần đồng thời + thương hiệu)");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    logger.info("Đang tắt server...");
    await stopWatch();
    await cronRunner.stop();
    await memoryWorker.stop();
    if (channelManager) await channelManager.stopAll();
    await mcp.stopAll();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
