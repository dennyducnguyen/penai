// Máy chủ GIẢ để xem giao diện Dashboard trên máy mà không cần PostgreSQL/LLM:
// phục vụ đúng INDEX_HTML đang sửa + trả dữ liệu mẫu cố định cho vài API.
//   pnpm exec tsx scripts/mock-dashboard.ts   → http://127.0.0.1:18899/#/users
import { createServer } from "node:http";
import { BrandingSchema } from "../packages/shared/src/index.js";
import { INDEX_HTML } from "../apps/server/src/ui.js";
import { defaultLogoSvg, renderIndexHtml } from "../apps/server/src/branding.js";

const port = Number(process.env.PORT ?? 18899);
const branding = BrandingSchema.parse({});
const agents = [{ id: "a1", key: "tro-ly", name: "Trợ lý", provider: "codex", model: "gpt-5.5" }];
const me = {
  user: { id: "u1", email: "admin@example.com", name: "Quản trị" },
  workspace: { id: "w1", name: "Công ty" },
  role: "ws_admin",
  roleLabel: "Quản trị",
  authKind: "web",
  mustChangePassword: false,
};
const users = [
  { id: "u1", name: "Quản trị", email: "admin@example.com", role: "ws_admin", agentIds: [], isActive: true, lastLoginAt: new Date().toISOString() },
  { id: "u2", name: "Nhân viên A", email: "nva@example.com", role: "member", agentIds: ["a1"], isActive: true, lastLoginAt: null },
];

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const json = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(renderIndexHtml(INDEX_HTML, branding));
  }
  if (path === "/brand/logo.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    return res.end(defaultLogoSvg(branding));
  }
  if (path === "/auth/me") return json(me);
  if (path === "/v1/users") return json({ users, agents });
  if (path === "/v1/agents") return json({ agents });
  return json({});
}).listen(port, "127.0.0.1", () => console.log(`Dashboard giả: http://127.0.0.1:${port}/#/users`));
