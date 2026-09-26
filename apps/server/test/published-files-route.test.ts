import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WorkspaceContext } from "@penai/shared";
import { PenaiConfigSchema } from "@penai/shared";
import { createDb, createPublishedFile, saveLandingPage, type DbHandle } from "@penai/db";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";

let fx: TestFixtures;
let dbh: DbHandle;
let app: FastifyInstance;
let dataDir = "";

const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

async function publish(
  token: string,
  absPath: string,
  over: Partial<Parameters<typeof createPublishedFile>[2]> = {},
) {
  return createPublishedFile(dbh.db, ctxA(), {
    tokenHash: hashOf(token),
    absPath,
    fileName: "hinh.png",
    contentType: "image/png",
    createdBy: "telegram-1",
    expiresAt: new Date(Date.now() + 3600_000),
    ...over,
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  dataDir = await mkdtemp(join(tmpdir(), "penai-pubf-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    // provider không được gọi trong các test này — chỉ cần config hợp lệ
    providers: { default: { kind: "openai-compat", baseURL: "http://127.0.0.1:9" } },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
});
afterAll(async () => {
  await app.close();
  await dbh.close();
});

describe("GET /f/:token — link file công khai", () => {
  const token = "abcdefghijklmnopqrstuvwxyz012345";

  it("token đúng → 200, đúng content-type + header chống XSS, không cần auth", async () => {
    const dir = join(dataDir, fx.wsA, "users", "telegram-1");
    await mkdir(dir, { recursive: true });
    const abs = join(dir, "hinh.png");
    await writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await publish(token, abs);

    const res = await app.inject({ method: "GET", url: `/f/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("token sai / quá ngắn → 404", async () => {
    expect((await app.inject({ method: "GET", url: "/f/khong-ton-tai-dai-du-20-ky-tu" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/f/ngan" })).statusCode).toBe(404);
  });

  it("hết hạn → 410", async () => {
    const t = "expiredtoken0123456789abcdefghij";
    const abs = join(dataDir, fx.wsA, "users", "telegram-1", "hinh.png");
    await publish(t, abs, { expiresAt: new Date(Date.now() - 1000) });
    expect((await app.inject({ method: "GET", url: `/f/${t}` })).statusCode).toBe(410);
  });

  it("file nằm ngoài dataDir → 404 (không lộ file hệ thống)", async () => {
    const t = "outsidetoken0123456789abcdefghij";
    await publish(t, join(tmpdir(), "ngoai-vung.txt"));
    expect((await app.inject({ method: "GET", url: `/f/${t}` })).statusCode).toBe(404);
  });

  it("thu hồi qua API → link chết", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/v1/files/published",
      headers: auth(fx.keys.aAdmin),
    });
    expect(list.statusCode).toBe(200);
    const files = (list.json() as { files: Array<{ id: string; fileName: string }> }).files;
    expect(files.length).toBeGreaterThan(0);

    // viewer không được thu hồi
    const denied = await app.inject({
      method: "DELETE",
      url: `/v1/files/published/${files[0]!.id}`,
      headers: auth(fx.keys.aViewer),
    });
    expect(denied.statusCode).toBe(403);

    // thu hồi link đầu tiên (token hợp lệ ở test 1)
    for (const f of files) {
      await app.inject({
        method: "DELETE",
        url: `/v1/files/published/${f.id}`,
        headers: auth(fx.keys.aAdmin),
      });
    }
    expect((await app.inject({ method: "GET", url: `/f/${token}` })).statusCode).toBe(404);
  });
});

describe("GET /landing/:id/:slug — landing page công khai", () => {
  it("trả HTML có inline JS trong sandbox không có allow-same-origin", async () => {
    const page = await saveLandingPage(dbh.db, ctxA(), {
      slug: "demo",
      title: "Demo",
      html: "<!doctype html><html><body><script>document.body.dataset.ok='1'</script></body></html>",
      createdByAgentId: fx.agentA,
    });
    const res = await app.inject({ method: "GET", url: `/landing/${page.id}/demo` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(res.body).toContain("document.body.dataset.ok");
  });

  it("UUID sai hoặc không tồn tại → 404 không cần auth", async () => {
    expect((await app.inject({ method: "GET", url: "/landing/sai/demo" })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/landing/00000000-0000-4000-8000-000000000000/demo",
        })
      ).statusCode,
    ).toBe(404);
  });
});
