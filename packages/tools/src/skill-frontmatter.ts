/**
 * Đọc frontmatter YAML đầu file SKILL.md.
 * Chỉ hỗ trợ cặp key: value phẳng + list dạng [a, b] hoặc "- a" — đủ cho
 * name/description/slug/author/tags mà không cần thêm phụ thuộc YAML.
 *
 *   ---
 *   name: Viết email
 *   description: Hướng dẫn soạn email bán hàng
 *   tags: [email, sales]
 *   ---
 *   # Nội dung...
 */
export interface SkillFrontmatter {
  fields: Record<string, string>;
  tags: string[];
  /** Phần nội dung sau frontmatter (nếu không có frontmatter thì là toàn bộ). */
  body: string;
}

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const m = FM_RE.exec(raw);
  if (!m) return { fields: {}, tags: [], body: raw.trim() };

  const fields: Record<string, string> = {};
  const tags: string[] = [];
  let lastKey = "";

  for (const line of m[1]!.split(/\r?\n/)) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && lastKey) {
      const val = stripQuotes(listItem[1]!.trim());
      if (lastKey === "tags") tags.push(val);
      else fields[lastKey] = fields[lastKey] ? `${fields[lastKey]}, ${val}` : val;
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    lastKey = key;
    if (key === "tags") {
      const inline = /^\[(.*)\]$/.exec(value);
      if (inline) {
        for (const t of inline[1]!.split(",")) {
          const v = stripQuotes(t.trim());
          if (v) tags.push(v);
        }
      } else if (value) {
        for (const t of value.split(",")) {
          const v = stripQuotes(t.trim());
          if (v) tags.push(v);
        }
      }
      continue;
    }
    if (value) fields[key] = stripQuotes(value);
  }

  return { fields, tags, body: raw.slice(m[0].length).trim() };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Chuẩn hóa tên thành slug (a-z0-9-). */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
