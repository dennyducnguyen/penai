import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  extractWikilinks,
  upsertVaultDoc,
  getVaultDoc,
  searchVault,
  upsertEntity,
  addRelation,
  findEntityByName,
  traverseGraph,
  type DbHandle,
} from "../src/index.js";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "../src/testing.js";

let fx: TestFixtures;
let dbh: DbHandle;
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});
afterAll(async () => {
  await dbh.close();
});

describe("wikilinks", () => {
  it("trích [[link]]", () => {
    expect(extractWikilinks("Xem [[bao-cao-q3]] và [[ke-hoach]] nhé")).toEqual([
      "bao-cao-q3",
      "ke-hoach",
    ]);
  });
});

describe("vault (tsvector + upsert)", () => {
  it("tạo + search + get; upsert cập nhật", async () => {
    await upsertVaultDoc(dbh.db, ctxA(), {
      slug: "quy-trinh-ban-hang",
      title: "Quy trình bán hàng",
      content: "Bước 1 tiếp nhận. Bước 2 báo giá. Xem thêm [[chinh-sach-gia]].",
    });
    const hits = await searchVault(dbh.db, ctxA(), "báo giá bán hàng", 5);
    expect(hits[0]!.slug).toBe("quy-trinh-ban-hang");
    expect(hits[0]!.snippet).toContain("báo giá");

    // Không dấu vẫn khớp tài liệu có dấu
    const noAccent = await searchVault(dbh.db, ctxA(), "bao gia", 5);
    expect(noAccent[0]!.slug).toBe("quy-trinh-ban-hang");

    // Chỉ cần khớp MỘT PHẦN từ khóa (FTS cũ bắt khớp đủ cả câu nên trả rỗng)
    const partial = await searchVault(dbh.db, ctxA(), "chính sách báo giá khuyến mãi", 5);
    expect(partial.map((h) => h.slug)).toContain("quy-trinh-ban-hang");

    await upsertVaultDoc(dbh.db, ctxA(), {
      slug: "quy-trinh-ban-hang",
      title: "Quy trình bán hàng v2",
      content: "Nội dung mới",
    });
    const d = await getVaultDoc(dbh.db, ctxA(), "quy-trinh-ban-hang");
    expect(d!.title).toBe("Quy trình bán hàng v2");
  });
});

describe("knowledge graph (entity + relation + traversal)", () => {
  it("upsert entity idempotent + traverse recursive", async () => {
    const abc = await upsertEntity(dbh.db, ctxA(), { name: "ABC", type: "company", summary: "Công ty ABC" });
    const san = await upsertEntity(dbh.db, ctxA(), { name: "Sàn TMĐT", type: "platform" });
    const sale = await upsertEntity(dbh.db, ctxA(), { name: "Gian hàng ABC", type: "store" });
    // upsert cùng tên (khác hoa thường) → cùng id
    const abc2 = await upsertEntity(dbh.db, ctxA(), { name: "abc" });
    expect(abc2).toBe(abc);

    await addRelation(dbh.db, ctxA(), abc, sale, "sở hữu");
    await addRelation(dbh.db, ctxA(), sale, san, "bán trên");

    const found = await findEntityByName(dbh.db, ctxA(), "ABC");
    expect(found!.summary).toBe("Công ty ABC");

    const nodes = await traverseGraph(dbh.db, ctxA(), "ABC", 2);
    const names = nodes.map((n) => n.name);
    expect(names).toContain("Gian hàng ABC"); // depth 1
    expect(names).toContain("Sàn TMĐT"); // depth 2 (qua recursive)
  });
});
