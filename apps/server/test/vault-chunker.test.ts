import { describe, expect, it } from "vitest";
import { chunkVaultMarkdown, estimateTokens, normalizeVaultText } from "../src/vault-chunker.js";
import { aggregateHitsByDocument, mergeVaultRrf, type HybridVaultHit } from "../src/vault-runtime.js";
import type { VaultCandidate } from "@penai/db";

describe("Vault chunker", () => {
  it("mặc định giữ heading và không vượt xa ngân sách", () => {
    const text = "# Chính sách\n\n" + Array.from({ length: 60 }, (_, i) => `Đoạn ${i}: Nội dung quy định thanh toán và giao hàng.`).join("\n\n");
    const chunks = chunkVaultMarkdown(text, 100, 15);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c, i) => c.ordinal === i)).toBe(true);
    expect(chunks.every((c) => c.headingPath === "Chính sách")).toBe(true);
    // chunk có thể vượt nhẹ (tối đa + overlap) — KHÔNG cắt bỏ nội dung
    expect(Math.max(...chunks.map((c) => c.tokenCount))).toBeLessThanOrEqual(100 + 15 + 10);
  });

  it("cắt được đoạn đơn rất dài và có overlap", () => {
    const chunks = chunkVaultMarkdown("từ ".repeat(2000), 80, 10);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.content.length > 0)).toBe(true);
  });

  it("KHÔNG mất nội dung với đoạn văn dài hơn chunk (bug cũ rơi ~12%)", () => {
    // Một đoạn duy nhất 3000 từ đánh số — bản chunker cũ cắt đuôi phần overlap
    // và làm biến mất hàng trăm từ. Mọi từ phải xuất hiện trong ít nhất 1 chunk.
    const words = Array.from({ length: 3000 }, (_, i) => `tok${String(i).padStart(4, "0")}`);
    const chunks = chunkVaultMarkdown(words.join(" "), 200, 40);
    const joined = chunks.map((c) => c.content).join(" ");
    const missing = words.filter((w) => !joined.includes(w));
    expect(missing).toEqual([]);
  });

  it("KHÔNG mất nội dung với nhiều đoạn có câu dài lẫn ngắn", () => {
    const markers: string[] = [];
    const paragraphs: string[] = [];
    for (let p = 0; p < 12; p++) {
      const marker = `dinhdanh${p}x`;
      markers.push(marker);
      paragraphs.push(
        p % 3 === 0
          ? `Câu rất dài không có dấu chấm ${"nội dung lặp ".repeat(120)} ${marker} kết thúc đoạn.`
          : `Đoạn ngắn ${p} có ${marker}. Thêm một câu nữa cho đủ ý.`,
      );
    }
    const chunks = chunkVaultMarkdown(paragraphs.join("\n\n"), 150, 30);
    const joined = chunks.map((c) => c.content).join(" ");
    for (const marker of markers) expect(joined).toContain(marker);
  });

  it("chuẩn hóa tìm kiếm tiếng Việt không dấu", () => {
    expect(normalizeVaultText("Điều khoản ĐẶC BIỆT")).toBe("dieu khoan dac biet");
    expect(estimateTokens("Một câu ngắn")).toBeGreaterThan(0);
  });
});

const candidate = (id: string, over: Partial<VaultCandidate> = {}): VaultCandidate => ({
  chunkId: id,
  documentId: `doc-${id}`,
  collectionId: "collection",
  collectionName: "Kho test",
  collectionPriority: 0,
  retrievalMode: "auto",
  slug: `slug-${id}`,
  title: `Tài liệu ${id}`,
  ordinal: 0,
  headingPath: "",
  content: `Nội dung ${id}`,
  tokenCount: 10,
  score: 1,
  ...over,
});

describe("Vault hybrid RRF", () => {
  it("đẩy chunk có ở cả keyword và vector lên đầu", () => {
    const rows = mergeVaultRrf([candidate("a"), candidate("b")], [candidate("b"), candidate("c")]);
    expect(rows[0]!.chunkId).toBe("b");
    expect(rows[0]!.sources).toEqual(["lexical", "vector"]);
    expect(rows).toHaveLength(3);
  });
});

describe("aggregateHitsByDocument (document-first)", () => {
  const hit = (id: string, docId: string, rrf: number, over: Partial<VaultCandidate> = {}): HybridVaultHit => ({
    ...candidate(id, { documentId: docId, ...over }),
    rrfScore: rrf,
    sources: ["lexical"],
  });

  it("cộng dồn điểm chunk theo tài liệu và xếp hạng", () => {
    const docs = aggregateHitsByDocument([
      hit("a1", "doc-A", 0.01),
      hit("b1", "doc-B", 0.016),
      hit("a2", "doc-A", 0.009),
    ]);
    expect(docs[0]!.documentId).toBe("doc-A"); // 0.019 > 0.016
    expect(docs[0]!.hitCount).toBe(2);
    expect(docs[1]!.documentId).toBe("doc-B");
  });

  it("priority collection chỉ phân thắng khi điểm sát nhau", () => {
    const close = aggregateHitsByDocument([
      hit("a1", "doc-A", 0.016, { collectionPriority: 0 }),
      hit("b1", "doc-B", 0.016, { collectionPriority: 10 }),
    ]);
    expect(close[0]!.documentId).toBe("doc-B");
    // chênh lệch rõ thì priority không lật được kết quả
    const clear = aggregateHitsByDocument([
      hit("a1", "doc-A", 0.03, { collectionPriority: 0 }),
      hit("b1", "doc-B", 0.016, { collectionPriority: 100 }),
    ]);
    expect(clear[0]!.documentId).toBe("doc-A");
  });
});
