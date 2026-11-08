/**
 * API Thư viện file của agent (Dashboard → Thư viện file, 26/09/2026).
 * Quyền operator+, tên file không dấu, chống traversal, thùng rác, hạn mức,
 * scope workspace khác, bật quyền ghi (ws_admin) có audit.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema } from "@penai/shared";
import { createDb, type DbHandle } from "@penai/db";
import {
  adminQuery,
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { startMockLlm, type MockLlm } from "@penai/providers/mock-llm";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";

let fx: TestFixtures;
let dbh: DbHandle;
let mock: MockLlm;
let app: FastifyInstance;
let dataDir = "";

const H = (key: string) => ({ authorization: `Bearer ${key}` });
const put = (key: string, scope: string, path: string, body: string | Buffer, overwrite = false) =>
  app.inject({
    method: "PUT",
    url: `/v1/library/${scope}/file?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`,
    headers: { ...H(key), "content-type": "application/octet-stream" },
    payload: typeof body === "string" ? Buffer.from(body, "utf8") : body,
  });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  mock = await startMockLlm();
  dataDir = await mkdtemp(join(tmpdir(), "penai-library-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    providers: { default: { kind: "openai-compat", baseURL: mock.url } },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await dbh.close();
});

describe("Thư viện file: quyền + liệt kê", () => {
  it("viewer bị từ chối, operator thấy scope chung + agent của workspace mình", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/library", headers: H(fx.keys.aViewer) })).statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url: "/v1/library", headers: H(fx.keys.aOperator) });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { scopes: Array<{ id: string; kind: string }>; canToggleWrite: boolean };
    expect(j.scopes[0]!.id).toBe("shared");
    expect(j.scopes.some((s) => s.id === fx.agentA)).toBe(true);
    expect(j.scopes.some((s) => s.id === fx.agentB)).toBe(false);
    expect(j.canToggleWrite).toBe(false);
  });

  it("scope là agent của workspace khác → 404", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/library/${fx.agentB}/list`, headers: H(fx.keys.aOperator) });
    expect(res.statusCode).toBe(404);
  });
});

describe("Thư viện file: tải lên / thư mục / đổi tên / xóa", () => {
  it("tải lên → tên không dấu, nằm đúng thư mục thư viện của agent, tải về đúng nội dung", async () => {
    const res = await put(fx.keys.aOperator, fx.agentA, "Mẫu Báo Giá 2026.DOCX", "noi dung 1");
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("mau-bao-gia-2026.docx");
    const disk = join(dataDir, "thu-vien", fx.wsA, fx.agentA, "mau-bao-gia-2026.docx");
    expect(await readFile(disk, "utf8")).toBe("noi dung 1");
    const list = await app.inject({ method: "GET", url: `/v1/library/${fx.agentA}/list`, headers: H(fx.keys.aOperator) });
    const lj = list.json() as { entries: Array<{ name: string }>; agentPath: string };
    expect(lj.entries.map((e) => e.name)).toContain("mau-bao-gia-2026.docx");
    expect(lj.agentPath).toBe("thu-vien");
    const dl = await app.inject({
      method: "GET",
      url: `/v1/library/${fx.agentA}/file?path=mau-bao-gia-2026.docx&dl=1`,
      headers: H(fx.keys.aOperator),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe("noi dung 1");
  });

  it("thư mục mới trong đường dẫn tải lên cũng chuyển thành không dấu", async () => {
    const res = await put(fx.keys.aOperator, fx.agentA, "Thư Mục Mới/Tệp A.txt", "a");
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("thu-muc-moi/tep-a.txt");
    const again = await put(fx.keys.aOperator, fx.agentA, "thu-muc-moi/Tệp B.txt", "b");
    expect(again.json().path).toBe("thu-muc-moi/tep-b.txt");
  });

  it("trùng tên → 409; ghi đè → bản cũ vào thùng rác", async () => {
    const dup = await put(fx.keys.aOperator, fx.agentA, "mau-bao-gia-2026.docx", "noi dung 2");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().exists).toBe(true);
    const ow = await put(fx.keys.aOperator, fx.agentA, "mau-bao-gia-2026.docx", "noi dung 2", true);
    expect(ow.statusCode).toBe(200);
    expect(ow.json().overwritten).toBe(true);
    const trash = await app.inject({ method: "GET", url: `/v1/library/${fx.agentA}/trash`, headers: H(fx.keys.aOperator) });
    const items = (trash.json() as { items: Array<{ path: string; reason: string }> }).items;
    expect(items.some((i) => i.path === "mau-bao-gia-2026.docx" && /ghi đè/.test(i.reason))).toBe(true);
  });

  it("chặn đường dẫn đi ngược ra ngoài", async () => {
    for (const url of [
      `/v1/library/${fx.agentA}/list?path=${encodeURIComponent("../..")}`,
      `/v1/library/${fx.agentA}/file?path=${encodeURIComponent("../../../etc/passwd")}`,
    ]) {
      expect((await app.inject({ method: "GET", url, headers: H(fx.keys.aOperator) })).statusCode).toBe(400);
    }
    expect((await put(fx.keys.aOperator, fx.agentA, "../ra-ngoai.txt", "x")).statusCode).toBe(400);
  });

  it("tạo thư mục con, tải vào, đổi tên, không chuyển thư mục vào chính nó", async () => {
    const mk = await app.inject({
      method: "POST",
      url: `/v1/library/${fx.agentA}/mkdir`,
      headers: H(fx.keys.aOperator),
      payload: { path: "", name: "Mẫu Hợp Đồng" },
    });
    expect(mk.statusCode).toBe(200);
    expect(mk.json().path).toBe("mau-hop-dong");
    expect((await put(fx.keys.aOperator, fx.agentA, "mau-hop-dong/a.txt", "A")).statusCode).toBe(200);
    const mv = await app.inject({
      method: "POST",
      url: `/v1/library/${fx.agentA}/move`,
      headers: H(fx.keys.aOperator),
      payload: { from: "mau-hop-dong/a.txt", to: "mau-hop-dong/Hợp đồng B.txt" },
    });
    expect(mv.statusCode).toBe(200);
    expect(mv.json().path).toBe("mau-hop-dong/hop-dong-b.txt");
    const bad = await app.inject({
      method: "POST",
      url: `/v1/library/${fx.agentA}/move`,
      headers: H(fx.keys.aOperator),
      payload: { from: "mau-hop-dong", to: "mau-hop-dong/con" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("xóa thư mục → thùng rác → khôi phục → xóa hẳn", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/library/${fx.agentA}/entry?path=mau-hop-dong`,
      headers: H(fx.keys.aOperator),
    });
    expect(del.statusCode).toBe(200);
    const id = del.json().trashId as string;
    const list = await app.inject({ method: "GET", url: `/v1/library/${fx.agentA}/list`, headers: H(fx.keys.aOperator) });
    expect((list.json() as { entries: Array<{ name: string }> }).entries.some((e) => e.name === "mau-hop-dong")).toBe(false);
    const rs = await app.inject({ method: "POST", url: `/v1/library/${fx.agentA}/trash/${id}/restore`, headers: H(fx.keys.aOperator) });
    expect(rs.statusCode).toBe(200);
    expect(await readFile(join(dataDir, "thu-vien", fx.wsA, fx.agentA, "mau-hop-dong", "hop-dong-b.txt"), "utf8")).toBe("A");
    const del2 = await app.inject({ method: "DELETE", url: `/v1/library/${fx.agentA}/entry?path=mau-hop-dong`, headers: H(fx.keys.aOperator) });
    const purge = await app.inject({ method: "DELETE", url: `/v1/library/${fx.agentA}/trash/${del2.json().trashId}`, headers: H(fx.keys.aOperator) });
    expect(purge.statusCode).toBe(200);
  });
});

describe("Thư viện file: thư mục chung, sao chép, lưu từ chat, hạn mức", () => {
  it("shared/: tải lên được; skills/ chỉ xem", async () => {
    expect((await put(fx.keys.aOperator, "shared", "logo-cong-ty.png", "png")).statusCode).toBe(200);
    expect((await put(fx.keys.aOperator, "shared", "skills/hack.txt", "x")).statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url: "/v1/library/shared/entry?path=skills", headers: H(fx.keys.aOperator) });
    expect(del.statusCode).toBe(403);
  });

  it("sao chép từ thư viện agent sang thư mục chung", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/library/copy",
      headers: H(fx.keys.aOperator),
      payload: { fromScope: fx.agentA, path: "mau-bao-gia-2026.docx", toScope: "shared", toDir: "mau" },
    });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(dataDir, fx.wsA, "shared", "mau", "mau-bao-gia-2026.docx"), "utf8")).toBe("noi dung 2");
  });

  it("lưu file trong khung chat vào thư viện agent", async () => {
    const userDir = join(dataDir, fx.wsA, "users", `web-${fx.userId}`);
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "bao-cao-dep.txt"), "ban dep", "utf8");
    const res = await app.inject({
      method: "POST",
      url: "/v1/library/import-chat",
      headers: H(fx.keys.aOperator),
      payload: { p: "bao-cao-dep.txt", toScope: fx.agentA, toDir: "mau-dep" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("mau-dep/bao-cao-dep.txt");
  });

  it("vượt hạn mức → 413", async () => {
    const saved = process.env.PENAI_LIBRARY_QUOTA_MB;
    process.env.PENAI_LIBRARY_QUOTA_MB = "0.0001"; // ~100 byte
    try {
      const res = await put(fx.keys.aOperator, fx.agentA, "lon.bin", Buffer.alloc(4096, 1));
      expect(res.statusCode).toBe(413);
    } finally {
      if (saved === undefined) delete process.env.PENAI_LIBRARY_QUOTA_MB;
      else process.env.PENAI_LIBRARY_QUOTA_MB = saved;
    }
  });
});

describe("Quyền ghi của agent vào thư viện", () => {
  it("operator không bật được; ws_admin bật được và có audit", async () => {
    const op = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${fx.agentA}`,
      headers: H(fx.keys.aOperator),
      payload: { libraryWritable: true },
    });
    expect(op.statusCode).toBe(403);
    const ad = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${fx.agentA}`,
      headers: H(fx.keys.aAdmin),
      payload: { libraryWritable: true },
    });
    expect(ad.statusCode).toBe(200);
    expect(ad.json().agent.libraryWritable).toBe(true);
    const rows = await adminQuery<{ action: string }>(
      `SELECT action FROM audit_log WHERE workspace_id = $1 AND action = 'library.agent_write_toggle'`,
      [fx.wsA],
    );
    expect(rows.length).toBe(1);
    const lib = await app.inject({ method: "GET", url: "/v1/library", headers: H(fx.keys.aAdmin) });
    const j = lib.json() as { scopes: Array<{ id: string; libraryWritable?: boolean }>; canToggleWrite: boolean };
    expect(j.canToggleWrite).toBe(true);
    expect(j.scopes.find((s) => s.id === fx.agentA)?.libraryWritable).toBe(true);
    const uploads = await adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = $1 AND action = 'library.upload'`,
      [fx.wsA],
    );
    expect(Number(uploads[0]!.n)).toBeGreaterThan(0);
  });
});

describe("Thư viện file: xem/sửa văn bản, lịch sử, zip, giải nén, xem trước (1.15.0)", () => {
  const S = () => fx.agentA;
  const text = (key: string, path: string) =>
    app.inject({ method: "GET", url: `/v1/library/${S()}/text?path=${encodeURIComponent(path)}`, headers: H(key) });
  const save = (key: string, body: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/v1/library/${S()}/text`, headers: H(key), payload: body });

  it("tạo file Markdown, đọc, sửa → bản cũ vào lịch sử; sửa chồng bản cũ → 409 kèm bản mới", async () => {
    const c = await save(fx.keys.aOperator, { path: "ghi chú/Quy trình bán hàng.md", content: "# Bản 1\n", create: true });
    expect(c.statusCode).toBe(200);
    const path = c.json().path as string;
    expect(path).toBe("ghi-chu/quy-trinh-ban-hang.md");
    const r1 = (await text(fx.keys.aOperator, path)).json() as { content: string; sha256: string };
    expect(r1.content).toBe("# Bản 1\n");
    const s2 = await save(fx.keys.aOperator, { path, content: "# Bản 2\n", baseSha256: r1.sha256 });
    expect(s2.statusCode).toBe(200);
    // Người thứ hai vẫn cầm sha của bản 1 → xung đột, nhận nội dung mới để gộp
    const s3 = await save(fx.keys.aOperator, { path, content: "# Bản của người khác\n", baseSha256: r1.sha256 });
    expect(s3.statusCode).toBe(409);
    expect(s3.json()).toMatchObject({ conflict: true, content: "# Bản 2\n" });
    const h = (await app.inject({ method: "GET", url: `/v1/library/${S()}/history?path=${encodeURIComponent(path)}`, headers: H(fx.keys.aOperator) })).json() as { items: Array<{ id: string; reason: string }> };
    expect(h.items).toHaveLength(1);
    expect(h.items[0]!.reason).toMatch(/trước khi sửa/);
    const old = await app.inject({ method: "GET", url: `/v1/library/${S()}/trash/${h.items[0]!.id}/text`, headers: H(fx.keys.aOperator) });
    expect(old.json().content).toBe("# Bản 1\n");
    // Danh sách thư mục không lộ file tạm
    const ls = (await app.inject({ method: "GET", url: `/v1/library/${S()}/list?path=ghi-chu`, headers: H(fx.keys.aOperator) })).json() as { entries: Array<{ name: string }> };
    expect(ls.entries.map((e) => e.name)).toEqual(["quy-trinh-ban-hang.md"]);
  });

  it("chỉ sửa được file văn bản; viewer bị chặn; đường dẫn ngược bị chặn", async () => {
    expect((await save(fx.keys.aOperator, { path: "anh.png", content: "x", create: true })).statusCode).toBe(415);
    expect((await save(fx.keys.aViewer, { path: "a.md", content: "x", create: true })).statusCode).toBe(403);
    expect((await text(fx.keys.aOperator, "../../etc/passwd.md")).statusCode).toBe(400);
  });

  it("tải thư mục thành .zip rồi giải nén lại đúng cấu trúc", async () => {
    await put(fx.keys.aOperator, S(), "goi/mot.txt", "1");
    await put(fx.keys.aOperator, S(), "goi/con/hai.txt", "22");
    const z = await app.inject({ method: "GET", url: `/v1/library/${S()}/zip?path=goi`, headers: H(fx.keys.aOperator) });
    expect(z.statusCode).toBe(200);
    expect(z.headers["content-type"]).toBe("application/zip");
    const up = await put(fx.keys.aOperator, S(), "nen/Goi Tai Ve.zip", z.rawPayload);
    expect(up.statusCode).toBe(200);
    const ex = await app.inject({ method: "POST", url: `/v1/library/${S()}/extract`, headers: H(fx.keys.aOperator), payload: { path: up.json().path } });
    expect(ex.statusCode).toBe(200);
    expect(ex.json()).toMatchObject({ into: "nen/goi-tai-ve", files: 2 });
    const back = await app.inject({ method: "GET", url: `/v1/library/${S()}/file?path=${encodeURIComponent("nen/goi-tai-ve/con/hai.txt")}`, headers: H(fx.keys.aOperator) });
    expect(back.body).toBe("22");
  });

  it("xem trước chỉ nhận PDF/Word/Excel/PowerPoint", async () => {
    await put(fx.keys.aOperator, S(), "x.txt", "chu");
    expect((await app.inject({ method: "GET", url: `/v1/library/${S()}/preview?path=x.txt`, headers: H(fx.keys.aOperator) })).statusCode).toBe(415);
  });

  it("trình soạn đóng gói sẵn phục vụ được, không cần đăng nhập", async () => {
    const r = await app.inject({ method: "GET", url: "/static/vendor/penai-editor.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("PenaiEditor");
  });
});
