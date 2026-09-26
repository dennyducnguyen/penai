import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { snapshotWorkDir, newDeliverables } from "../src/channels-runtime.js";

let dir = "";

/** mtime trên Windows có độ phân giải thô — chờ chút để chữ ký đổi. */
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "penai-autosend-"));
});

describe("tự động gửi file agent vừa tạo", () => {
  it("gửi tài liệu mới, bỏ qua script trung gian và USER.md", async () => {
    await writeFile(join(dir, "USER.md"), "ghi nho cu", "utf8");
    const before = await snapshotWorkDir(dir);
    await tick();

    // agent tạo trong lượt chat
    await writeFile(join(dir, "bao-cao.docx"), "noi dung docx", "utf8");
    await writeFile(join(dir, "tao_file.py"), "print(1)", "utf8"); // script trung gian
    await writeFile(join(dir, "USER.md"), "ghi nho moi", "utf8"); // memory, không gửi

    const out = await newDeliverables(dir, before);
    const names = out.map((p) => p.split(/[\\/]/).pop());
    expect(names).toEqual(["bao-cao.docx"]);
  });

  it("file có sẵn không đổi thì không gửi lại", async () => {
    await writeFile(join(dir, "cu.docx"), "noi dung", "utf8");
    const before = await snapshotWorkDir(dir);
    await tick();
    await writeFile(join(dir, "moi.xlsx"), "bang tinh", "utf8");

    const names = (await newDeliverables(dir, before)).map((p) => p.split(/[\\/]/).pop());
    expect(names).toEqual(["moi.xlsx"]);
  });

  it("file cũ được SỬA cũng gửi lại (bản cập nhật)", async () => {
    await writeFile(join(dir, "hop-dong.docx"), "ban 1", "utf8");
    const before = await snapshotWorkDir(dir);
    await tick();
    await writeFile(join(dir, "hop-dong.docx"), "ban 2 da sua", "utf8");

    const names = (await newDeliverables(dir, before)).map((p) => p.split(/[\\/]/).pop());
    expect(names).toEqual(["hop-dong.docx"]);
  });

  it("ảnh, pdf, zip đều được gửi; file rỗng và đuôi lạ thì không", async () => {
    const before = await snapshotWorkDir(dir);
    await tick();
    await writeFile(join(dir, "anh.png"), "PNGDATA", "utf8");
    await writeFile(join(dir, "tai-lieu.pdf"), "PDFDATA", "utf8");
    await writeFile(join(dir, "goi.zip"), "ZIPDATA", "utf8");
    await writeFile(join(dir, "rong.docx"), "", "utf8"); // 0 byte
    await writeFile(join(dir, "khong-duoi"), "abc", "utf8");
    await writeFile(join(dir, "tam.pyc"), "x", "utf8");

    const names = (await newDeliverables(dir, before)).map((p) => p.split(/[\\/]/).pop());
    expect(names.sort()).toEqual(["anh.png", "goi.zip", "tai-lieu.pdf"]);
  });

  it("bỏ qua thư mục ẩn, __pycache__, node_modules", async () => {
    const before = await snapshotWorkDir(dir);
    await tick();
    await mkdir(join(dir, "__pycache__"), { recursive: true });
    await writeFile(join(dir, "__pycache__", "a.json"), "{}", "utf8");
    await mkdir(join(dir, ".cache"), { recursive: true });
    await writeFile(join(dir, ".cache", "b.json"), "{}", "utf8");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "c.json"), "{}", "utf8");
    await writeFile(join(dir, "that.json"), "{}", "utf8");

    const names = (await newDeliverables(dir, before)).map((p) => p.split(/[\\/]/).pop());
    expect(names).toEqual(["that.json"]);
  });

  it("gửi tối đa 5 file, ưu tiên file mới nhất", async () => {
    const before = await snapshotWorkDir(dir);
    for (let i = 1; i <= 7; i++) {
      await tick();
      await writeFile(join(dir, `f${i}.txt`), `noi dung ${i}`, "utf8");
    }
    const out = await newDeliverables(dir, before);
    expect(out.length).toBe(5);
    expect(out[0]!.endsWith("f7.txt")).toBe(true); // mới nhất trước
  });

  it("file trong thư mục con cũng được phát hiện", async () => {
    const before = await snapshotWorkDir(dir);
    await tick();
    await mkdir(join(dir, "ket-qua"), { recursive: true });
    await writeFile(join(dir, "ket-qua", "tong-hop.xlsx"), "data", "utf8");

    const names = (await newDeliverables(dir, before)).map((p) => p.split(/[\\/]/).pop());
    expect(names).toEqual(["tong-hop.xlsx"]);
  });

  it("thư mục không tồn tại thì trả rỗng, không ném lỗi", async () => {
    await rm(dir, { recursive: true, force: true });
    expect(await snapshotWorkDir(dir)).toEqual(new Map());
    expect(await newDeliverables(dir, new Map())).toEqual([]);
  });
});
