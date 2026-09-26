export interface VaultChunk {
  ordinal: number;
  headingPath: string;
  content: string;
  tokenCount: number;
}

/** Ước lượng bảo thủ, không nạp tokenizer/model cục bộ trên VPS 2 GB. */
export function estimateTokens(text: string): number {
  const words = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(text.length / 4), Math.ceil(words * 1.15));
}

export function normalizeVaultText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lấy phần ĐUÔI của text trong ngân sách token (dùng cho overlap giữa 2 chunk). */
function tailWithinBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text.trim();
  const charBudget = Math.max(40, budget * 4);
  const rough = text.slice(-charBudget);
  const boundary = rough.search(/\s/);
  return rough.slice(boundary >= 0 ? boundary + 1 : 0).trim();
}

/**
 * Cắt một đoạn vượt ngân sách thành các phần ≤ budget, ưu tiên ranh giới
 * câu/xuống dòng, câu siêu dài mới rơi xuống mức từ. TUYỆT ĐỐI không vứt
 * nội dung (phiên bản cũ từng âm thầm làm rơi ~12% text của đoạn dài) và
 * chạy tuyến tính (bản cũ O(n²) quét lại cả chuỗi mỗi vòng, block event loop).
 */
function splitOversized(text: string, budget: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= budget) return [trimmed];
  const out: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  const flush = () => {
    const joined = current.join("").trim();
    if (joined) out.push(joined);
    current = [];
    tokens = 0;
  };
  // Giữ nguyên ký tự phân cách nhờ lookbehind → ghép lại không mất chữ nào
  const sentences = trimmed.split(/(?<=[.!?…;]\s)|(?<=\n)/);
  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    if (sentenceTokens > budget) {
      // Câu/dòng siêu dài (bảng CSV, log...) → gom theo từ
      for (const word of sentence.split(/(?<=\s)/)) {
        const wordTokens = estimateTokens(word);
        if (tokens + wordTokens > budget && current.length) flush();
        current.push(word);
        tokens += wordTokens;
      }
      continue;
    }
    if (tokens + sentenceTokens > budget && current.length) flush();
    current.push(sentence);
    tokens += sentenceTokens;
  }
  flush();
  return out;
}

/**
 * Chunk Markdown theo heading/đoạn trước, chỉ cắt mềm khi một đoạn vượt ngân sách.
 * Overlap lấy phần đuôi chunk trước. Chunk có thể vượt nhẹ chunkTokens (tối đa
 * + overlapTokens) — chấp nhận để KHÔNG BAO GIỜ cắt bỏ nội dung của block.
 */
export function chunkVaultMarkdown(
  content: string,
  chunkTokens = 800,
  overlapTokens = 100,
): VaultChunk[] {
  if (chunkTokens < 1 || overlapTokens < 0 || overlapTokens >= chunkTokens) {
    throw new Error("Cấu hình chunk/overlap không hợp lệ");
  }
  const headings: string[] = [];
  const blocks: Array<{ headingPath: string; text: string }> = [];
  let paragraph: string[] = [];
  let paragraphHeading = "";
  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ headingPath: paragraphHeading, text });
    paragraph = [];
  };

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      headings.splice(level - 1);
      headings[level - 1] = heading[2]!.trim();
      paragraphHeading = headings.filter(Boolean).join(" > ");
      continue;
    }
    if (!line.trim()) {
      flush();
      paragraphHeading = headings.filter(Boolean).join(" > ");
      continue;
    }
    if (!paragraph.length) paragraphHeading = headings.filter(Boolean).join(" > ");
    paragraph.push(line);
  }
  flush();

  const expanded = blocks.flatMap((block) =>
    splitOversized(block.text, chunkTokens).map((text) => ({ ...block, text })),
  );
  const chunks: VaultChunk[] = [];
  let current = "";
  let currentTokens = 0;
  let currentHeading = "";

  const push = () => {
    const text = current.trim();
    if (!text) return;
    chunks.push({
      ordinal: chunks.length,
      headingPath: currentHeading,
      content: text,
      tokenCount: estimateTokens(text),
    });
  };

  for (const block of expanded) {
    const blockTokens = estimateTokens(block.text);
    if (current && currentTokens + blockTokens > chunkTokens) {
      const previous = current;
      push();
      const overlap = overlapTokens ? tailWithinBudget(previous, overlapTokens) : "";
      current = overlap ? `${overlap}\n\n${block.text}` : block.text;
      currentTokens = (overlap ? estimateTokens(overlap) : 0) + blockTokens;
      currentHeading = block.headingPath;
    } else {
      if (!current) currentHeading = block.headingPath;
      current = current ? `${current}\n\n${block.text}` : block.text;
      currentTokens += blockTokens;
    }
  }
  push();
  return chunks;
}
