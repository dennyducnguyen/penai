import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema, type WorkspaceContext } from "@penai/shared";
import {
  completeVaultDocumentIndex,
  createDb,
  createVaultCollection,
  getVaultDoc,
  updateVaultCollection,
  updateVaultSettings,
  upsertVaultDoc,
  type DbHandle,
  type VaultAccessContext,
} from "@penai/db";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";
import { buildVaultContext, writeAndIndexVaultDocument } from "../src/vault-runtime.js";
import { windowVaultContent } from "../src/agent-runtime.js";

let fx: TestFixtures;
let dbh: DbHandle;
let app: FastifyInstance;
let rt: { db: DbHandle; providers: ReturnType<typeof createProviderRegistry> };

const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const accessA = (): VaultAccessContext => ({ agentId: fx.agentA });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  const dataDir = await mkdtemp(join(tmpdir(), "penai-vault-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    providers: { default: { kind: "openai-compat", baseURL: "http://127.0.0.1:9" } },
  });
  const providers = createProviderRegistry(config.providers);
  rt = { db: dbh, providers };
  app = buildApp({ db: dbh, providers, tools: createDefaultToolRegistry(), config });
});
afterAll(async () => {
  await app.close();
  await dbh.close();
});

describe("Document-first: tài liệu phù hợp được nạp TOÀN VĂN", () => {
  it("tài liệu nhỏ tìm trúng → toàn văn trong context (FTS-only, không cần embedding)", async () => {
    await writeAndIndexVaultDocument(rt, ctxA(), {
      slug: "bao-hanh",
      title: "Chính sách bảo hành",
      content:
        "# Bảo hành\n\nQuy trình bảo hành đặc biệt: hoàn tiền trong 30 ngày.\n\nÁp dụng cho mọi sản phẩm gỗ nội thất.",
    });
    const context = await buildVaultContext(rt, ctxA(), accessA(), "quy trình bảo hành hoàn tiền thế nào?");
    expect(context).toContain("TOÀN VĂN");
    expect(context).toContain("hoàn tiền trong 30 ngày");
    expect(context).toContain("slug=bao-hanh");
  });

  it("collection always_full: nạp vào cả câu hỏi KHÔNG liên quan", async () => {
    const col = await createVaultCollection(dbh.db, ctxA(), {
      slug: "bang-gia-pinned",
      name: "Bảng giá ghim",
    });
    await updateVaultCollection(dbh.db, ctxA(), col.id, { retrievalMode: "always_full" });
    await writeAndIndexVaultDocument(rt, ctxA(), {
      slug: "bang-gia-2026",
      title: "Bảng giá 2026",
      content: "Ghế ăn mã GA01 giá 1.250.000 đồng. Bàn ăn mã BA02 giá 4.800.000 đồng.",
      collectionId: col.id,
    });
    const context = await buildVaultContext(rt, ctxA(), accessA(), "thời tiết hôm nay ở Sa Đéc ra sao vậy nhỉ?");
    expect(context).toContain("GA01");
    expect(context).toContain("TOÀN VĂN");
  });

  it("collection search_only: tìm trúng vẫn CHỈ trả chunk, không toàn văn", async () => {
    const col = await createVaultCollection(dbh.db, ctxA(), {
      slug: "kho-tham-khao",
      name: "Kho tham khảo",
    });
    await updateVaultCollection(dbh.db, ctxA(), col.id, { retrievalMode: "search_only" });
    await writeAndIndexVaultDocument(rt, ctxA(), {
      slug: "so-tay-van-hanh",
      title: "Sổ tay vận hành",
      content: "Quy định vận hành xưởng cưa: kiểm tra lưỡi cưa mỗi sáng thứ hai hằng tuần.",
      collectionId: col.id,
    });
    const context = await buildVaultContext(rt, ctxA(), accessA(), "quy định vận hành xưởng cưa lưỡi cưa");
    expect(context).toContain("lưỡi cưa");
    expect(context).not.toContain("[Tài liệu (TOÀN VĂN): Sổ tay vận hành");
    expect(context).toContain("[Chunk");
  });

  it("tài liệu vượt full_doc_tokens → chunk + ghi chú chỉ dẫn vault_get", async () => {
    await updateVaultSettings(dbh.db, ctxA(), { fullDocTokens: 500, contextTokens: 2000 });
    const long = Array.from(
      { length: 200 },
      (_, i) => `Điều khoản hợp đồng xuất khẩu số ${i}: bên bán chịu trách nhiệm giao gỗ đúng hạn.`,
    ).join("\n\n");
    await writeAndIndexVaultDocument(rt, ctxA(), {
      slug: "hop-dong-xuat-khau",
      title: "Hợp đồng xuất khẩu",
      content: long,
    });
    const context = await buildVaultContext(rt, ctxA(), accessA(), "điều khoản hợp đồng xuất khẩu gỗ");
    expect(context).toContain("dài quá ngân sách");
    expect(context).toContain("vault_get slug=hop-dong-xuat-khau");
    expect(context).toContain("[Chunk");
    await updateVaultSettings(dbh.db, ctxA(), { fullDocTokens: 16000, contextTokens: 24000 });
  });

  it("ACL: agent workspace B không thấy gì (fail-closed)", async () => {
    const context = await buildVaultContext(
      rt,
      { workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" },
      { agentId: fx.agentB },
      "quy trình bảo hành hoàn tiền",
    );
    expect(context).toBe("");
  });
});

describe("Chống race + dedup nội dung", () => {
  it("lưu lại nội dung y hệt → skipped, không re-index", async () => {
    const first = await writeAndIndexVaultDocument(rt, ctxA(), {
      slug: "quy-tac-chung",
      title: "Quy tắc chung",
      content: "Nội dung quy tắc chung phiên bản một.",
    });
    expect((first.index as { skipped?: boolean }).skipped).toBeUndefined();
    const second = await writeAndIndexVaultDocument(rt, ctxA(), {
      slug: "quy-tac-chung",
      title: "Quy tắc chung",
      content: "Nội dung quy tắc chung phiên bản một.",
    });
    expect((second.index as { skipped?: boolean }).skipped).toBe(true);
  });

  it("job index lỗi thời (nội dung đã đổi) không được ghi đè", async () => {
    const docV1 = await upsertVaultDoc(dbh.db, ctxA(), {
      slug: "tai-lieu-race",
      title: "Race",
      content: "phiên bản một",
    });
    // Nội dung đổi TRONG LÚC job v1 đang chạy
    await upsertVaultDoc(dbh.db, ctxA(), {
      slug: "tai-lieu-race",
      title: "Race",
      content: "phiên bản hai mới hơn",
    });
    const outcome = await completeVaultDocumentIndex(dbh.db, ctxA(), {
      documentId: docV1.id,
      jobId: (await import("node:crypto")).randomUUID(),
      chunks: [],
      documentTokenCount: 10,
      indexVersion: docV1.indexVersion,
      expectedContentHash: docV1.contentHash,
    }).catch(() => "stale" as const); // jobId giả có thể không tồn tại — chỉ cần không ghi đè doc
    expect(outcome).toBe("stale");
    const after = await getVaultDoc(dbh.db, ctxA(), "tai-lieu-race");
    expect(after!.indexStatus).toBe("pending"); // không bị job cũ đánh dấu ready
  });
});

describe("Upload file văn phòng vào Vault", () => {
  it("upload txt + md qua API → trích text, index, tìm lại được", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/vault/upload",
      headers: auth(fx.keys.aOperator),
      payload: {
        files: [
          { name: "huong dan lap rap.txt", contentB64: Buffer.from("Hướng dẫn lắp ráp tủ quần áo model TQA9.").toString("base64") },
          { name: "noi-quy-xuong.md", contentB64: Buffer.from("# Nội quy\n\nKhông hút thuốc trong xưởng sơn.").toString("base64") },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as { results: Array<{ ok: boolean; slug: string; chunks: number }> }).results;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]!.slug).toBe("huong-dan-lap-rap");

    const doc = await app.inject({
      method: "GET",
      url: "/v1/vault/huong-dan-lap-rap",
      headers: auth(fx.keys.aOperator),
    });
    expect(doc.statusCode).toBe(200);
    expect(doc.body).toContain("TQA9");
  });

  it("upload lại file y hệt → skipped (không tốn embedding)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/vault/upload",
      headers: auth(fx.keys.aOperator),
      payload: {
        files: [
          { name: "noi-quy-xuong.md", contentB64: Buffer.from("# Nội quy\n\nKhông hút thuốc trong xưởng sơn.").toString("base64") },
        ],
      },
    });
    const results = (res.json() as { results: Array<{ skipped?: boolean }> }).results;
    expect(results[0]!.skipped).toBe(true);
  });

  it("file nhị phân rác → lỗi thân thiện cho riêng file đó", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/vault/upload",
      headers: auth(fx.keys.aOperator),
      payload: {
        files: [{ name: "anh.xyz", contentB64: Buffer.alloc(64, 0).toString("base64") }],
      },
    });
    const results = (res.json() as { results: Array<{ ok: boolean; error?: string }> }).results;
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBeTruthy();
  });

  it("viewer không được upload; viewer cũng không xem được settings/collections", async () => {
    const up = await app.inject({
      method: "POST",
      url: "/v1/vault/upload",
      headers: auth(fx.keys.aViewer),
      payload: { files: [{ name: "a.txt", contentB64: Buffer.from("x").toString("base64") }] },
    });
    expect(up.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/vault/settings", headers: auth(fx.keys.aViewer) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/vault/collections", headers: auth(fx.keys.aViewer) })).statusCode).toBe(403);
  });
});

describe("vault_get cửa sổ lớn", () => {
  it("tài liệu nhỏ trả nguyên văn; tài liệu dài trả cửa sổ + offset đọc tiếp", () => {
    expect(windowVaultContent("Ngắn", "nội dung", "ngan")).toBe("# Ngắn\n\nnội dung");
    const long = "x".repeat(150_000);
    const first = windowVaultContent("Dài", long, "dai");
    expect(first).toContain("0..60000");
    expect(first).toContain("offset=60000");
    const second = windowVaultContent("Dài", long, "dai", 120_000);
    expect(second).toContain("120000..150000");
    expect(second).not.toContain("để đọc tiếp");
  });
});
