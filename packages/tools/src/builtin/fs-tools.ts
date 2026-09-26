import {
  copyFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../registry.js";
import {
  assertWritable,
  displayPath,
  libraryDirOf,
  resolveWorkPathChecked,
  sharedDirOf,
  workDirOf,
} from "../workspace-paths.js";
import type { ToolContext } from "../registry.js";

const MAX_WRITE = 5 * 1024 * 1024;

/**
 * Path ghi nhớ: MEMORY.md ở gốc thư mục làm việc hoặc mọi
 * file trong memory/. File nằm trên đĩa như file thường, nhưng mỗi lần
 * ghi/sửa/xóa được báo về runtime để lưu bản sao vào DB (memory_search).
 */
export function isMemoryPath(display: string): boolean {
  return (
    display === "MEMORY.md" ||
    display === "memory.md" ||
    display.startsWith("memory/")
  );
}

/** Báo runtime index lại file ghi nhớ — best-effort, không làm hỏng lượt ghi. */
async function syncMemoryDoc(
  toolCtx: ToolContext,
  res: { shared: boolean; library?: boolean; display: string; abs: string },
): Promise<string> {
  if (res.shared || res.library || !isMemoryPath(res.display) || !toolCtx.memory?.saveDoc) return "";
  try {
    const content = await readFile(res.abs, "utf8");
    await toolCtx.memory.saveDoc(res.display, content);
    return " (đã cập nhật bộ nhớ dài hạn — tìm lại được bằng memory_search)";
  } catch {
    return "";
  }
}

async function removeMemoryDoc(
  toolCtx: ToolContext,
  res: { shared: boolean; library?: boolean; display: string },
): Promise<void> {
  if (res.shared || res.library || !isMemoryPath(res.display) || !toolCtx.memory?.deleteDoc) return;
  await toolCtx.memory.deleteDoc(res.display).catch(() => {});
}


// ===== list =====

const listSchema = z.object({
  path: z
    .string()
    .default(".")
    .describe('Thư mục cần liệt kê. "." = thư mục riêng, "shared" = dùng chung, "thu-vien" = thư viện file của agent.'),
  recursive: z.boolean().default(false).describe("Liệt kê cả thư mục con."),
});

export const listFilesTool: ToolHandler<typeof listSchema> = {
  name: "list_files",
  description:
    'Liệt kê file/thư mục. Mặc định là thư mục làm việc riêng của người dùng; dùng "shared" để xem file dùng chung, "thu-vien" để xem thư viện file của agent.',
  schema: listSchema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = resolve(dir, e.name);
        const disp = displayPath(toolCtx, full);
        if (e.isDirectory()) {
          out.push(`📁 ${disp}/`);
          if (args.recursive && depth < 4) await walk(full, depth + 1);
        } else {
          const info = await stat(full);
          out.push(`📄 ${disp} (${info.size} bytes)`);
        }
      }
    };
    try {
      await walk(res.abs, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "(thư mục chưa tồn tại)";
      throw err;
    }
    return out.length ? out.join("\n") : "(thư mục trống)";
  },
};

// ===== write =====

const writeSchema = z.object({
  path: z.string().min(1).describe("Đường dẫn file (tương đối thư mục làm việc)."),
  content: z.string().describe("Nội dung văn bản."),
  append: z.boolean().default(false).describe("Nối vào cuối thay vì ghi đè."),
});

export const writeFileTool: ToolHandler<typeof writeSchema> = {
  name: "write_file",
  description:
    "Ghi file văn bản vào thư mục làm việc riêng (tạo mới, ghi đè, hoặc nối thêm).",
  schema: writeSchema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    assertWritable(res, toolCtx);
    if (Buffer.byteLength(args.content, "utf8") > MAX_WRITE) {
      throw new Error("Nội dung quá lớn (tối đa 5MB) — dùng exec để tạo file lớn");
    }
    await mkdir(dirname(res.abs), { recursive: true });
    if (args.append) {
      await writeFile(res.abs, args.content, { encoding: "utf8", flag: "a" });
    } else {
      await writeFile(res.abs, args.content, "utf8");
    }
    const memNote = await syncMemoryDoc(toolCtx, res);
    return `Đã ${args.append ? "nối" : "ghi"} ${Buffer.byteLength(args.content, "utf8")} bytes vào ${res.display}${memNote}`;
  },
};

// ===== edit (thay chuỗi) =====

const editSchema = z.object({
  path: z.string().min(1).describe("File cần sửa."),
  find: z.string().min(1).describe("Đoạn văn bản cần thay (khớp chính xác)."),
  replace: z.string().describe("Nội dung thay thế."),
  all: z.boolean().default(false).describe("Thay mọi lần xuất hiện (mặc định chỉ 1)."),
});

export const editFileTool: ToolHandler<typeof editSchema> = {
  name: "edit_file",
  description:
    "Sửa file bằng cách thay một đoạn văn bản. Mặc định đoạn cần thay phải xuất hiện đúng 1 lần.",
  schema: editSchema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    assertWritable(res, toolCtx);
    const content = await readFile(res.abs, "utf8");
    const count = content.split(args.find).length - 1;
    if (count === 0) throw new Error("Không tìm thấy đoạn văn bản cần thay");
    if (count > 1 && !args.all) {
      throw new Error(
        `Đoạn văn bản xuất hiện ${count} lần — thêm ngữ cảnh cho duy nhất, hoặc đặt all=true`,
      );
    }
    // Dùng split/join cho cả 2 nhánh: String.replace diễn giải $&, $1, $'
    // trong chuỗi thay thế → nội dung file bị biến dạng âm thầm.
    const idx = content.indexOf(args.find);
    const next = args.all
      ? content.split(args.find).join(args.replace)
      : content.slice(0, idx) + args.replace + content.slice(idx + args.find.length);
    await writeFile(res.abs, next, "utf8");
    const memNote = await syncMemoryDoc(toolCtx, res);
    return `Đã sửa ${res.display} (${args.all ? count : 1} chỗ)${memNote}`;
  },
};

// ===== move / delete / mkdir =====

const moveSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const moveFileTool: ToolHandler<typeof moveSchema> = {
  name: "move_file",
  description: "Di chuyển hoặc đổi tên file/thư mục trong thư mục làm việc.",
  schema: moveSchema,
  async execute(args, toolCtx) {
    const from = await resolveWorkPathChecked(toolCtx, args.from);
    const to = await resolveWorkPathChecked(toolCtx, args.to);
    assertWritable(from, toolCtx);
    assertWritable(to, toolCtx);
    await mkdir(dirname(to.abs), { recursive: true });
    await rename(from.abs, to.abs);
    await removeMemoryDoc(toolCtx, from);
    await syncMemoryDoc(toolCtx, to);
    return `Đã chuyển ${from.display} → ${to.display}`;
  },
};

const deleteSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false).describe("Xóa cả thư mục con."),
});

export const deleteFileTool: ToolHandler<typeof deleteSchema> = {
  name: "delete_file",
  description: "Xóa file hoặc thư mục trong thư mục làm việc riêng.",
  schema: deleteSchema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    assertWritable(res, toolCtx);
    if (
      res.abs === workDirOf(toolCtx) ||
      res.abs === sharedDirOf(toolCtx) ||
      res.abs === libraryDirOf(toolCtx)
    ) {
      throw new Error("Từ chối: không xóa được thư mục gốc");
    }
    if (res.library && toolCtx.libraryTrash) {
      await toolCtx.libraryTrash(res.abs);
      return `Đã chuyển ${res.display} vào thùng rác của thư viện (quản trị viên khôi phục được trong 30 ngày)`;
    }
    await rm(res.abs, { recursive: args.recursive, force: false });
    await removeMemoryDoc(toolCtx, res);
    return `Đã xóa ${res.display}`;
  },
};

const mkdirSchema = z.object({ path: z.string().min(1) });

export const makeDirTool: ToolHandler<typeof mkdirSchema> = {
  name: "make_dir",
  description: "Tạo thư mục (kể cả thư mục cha) trong thư mục làm việc.",
  schema: mkdirSchema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    assertWritable(res, toolCtx);
    await mkdir(res.abs, { recursive: true });
    return `Đã tạo thư mục ${res.display}`;
  },
};

// ===== gửi file cho người dùng =====

const sendSchema = z.object({
  path: z.string().min(1).describe("File cần gửi cho người dùng."),
  caption: z.string().optional().describe("Chú thích ngắn kèm file."),
});

export const sendFileTool: ToolHandler<typeof sendSchema> = {
  name: "send_file",
  description:
    "Gửi một file trong thư mục làm việc cho người dùng qua kênh chat (ảnh gửi dạng ảnh, còn lại dạng tài liệu). Dùng khi người dùng muốn nhận/tải file.",
  schema: sendSchema,
  async execute(args, toolCtx) {
    const res = await resolveWorkPathChecked(toolCtx, args.path);
    const info = await stat(res.abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`Không tìm thấy file ${res.display}`);
    if (info.size > 45 * 1024 * 1024) {
      throw new Error("File quá lớn để gửi qua chat (giới hạn ~45MB)");
    }
    if (!toolCtx.attachFile) {
      return `Kênh hiện tại chưa hỗ trợ gửi file. File nằm tại ${res.display}`;
    }
    // File trong thư viện: gửi BẢN SAO nằm trong thư mục làm việc — mọi kênh
    // (kể cả chat web, vốn chỉ phục vụ file trong thư mục người dùng) đều giao
    // được, người dùng có bản của riêng họ, bản gốc thư viện không bị đụng.
    if (res.library) {
      const copy = await copyIntoWorkDir(res.abs, workDirOf(toolCtx));
      toolCtx.attachFile(copy);
      return `Đã gửi bản sao của ${res.display} (lưu tại ${displayPath(toolCtx, copy)}) cho người dùng${args.caption ? ` (${args.caption})` : ""}`;
    }
    toolCtx.attachFile(res.abs);
    return `Đã gửi file ${res.display} cho người dùng${args.caption ? ` (${args.caption})` : ""}`;
  },
};

/**
 * Chép file vào gốc thư mục làm việc (giữ tên; đã có file cùng tên và cùng nội
 * dung thì dùng lại, khác nội dung thì thêm hậu tố -2, -3...).
 */
async function copyIntoWorkDir(src: string, workDir: string): Promise<string> {
  const name = basename(src);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const data = await readFile(src);
  await mkdir(workDir, { recursive: true });
  for (let i = 1; i < 100; i++) {
    const target = join(workDir, i === 1 ? name : `${stem}-${i}${ext}`);
    const existing = await readFile(target).catch(() => null);
    if (existing === null) {
      await copyFile(src, target);
      return target;
    }
    if (existing.equals(data)) return target;
  }
  throw new Error("Không tạo được bản sao file (trùng tên quá nhiều)");
}

/** Đường dẫn tương đối để log/hiển thị (dùng lại trong read-file). */
export function relativeDisplay(root: string, abs: string): string {
  return relative(root, abs).replaceAll(sep, "/");
}
