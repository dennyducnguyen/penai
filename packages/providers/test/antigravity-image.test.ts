import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aspectRatioFor,
  buildImagePrompt,
  extractImagePaths,
  findGeneratedImage,
  imageDimensions,
  sniffImageMime,
} from "../src/antigravity/provider.js";

describe("aspectRatioFor", () => {
  it("aspectRatio thắng size, quy về tỷ lệ tool hỗ trợ", () => {
    expect(aspectRatioFor("1024x1024", "16:9")).toBe("16:9");
    expect(aspectRatioFor(undefined, "1920:1080")).toBe("16:9");
    expect(aspectRatioFor("1536x1024")).toBe("3:2");
    expect(aspectRatioFor("1024x1536")).toBe("2:3");
    expect(aspectRatioFor("1376x768")).toBe("16:9");
  });

  it("không đủ thông tin → null (để model tự chọn)", () => {
    expect(aspectRatioFor("auto")).toBeNull();
    expect(aspectRatioFor()).toBeNull();
    expect(aspectRatioFor(undefined, "rộng")).toBeNull();
  });
});

describe("buildImagePrompt", () => {
  it("có ảnh tham chiếu + tỷ lệ → truyền ImagePaths/AspectRatio, mô tả nằm trong thẻ", () => {
    const p = buildImagePrompt("Đổi chữ thành MUA 1 TẶNG 1", ["/d/ref-1.jpg"], "16:9");
    expect(p).toContain("generate_image");
    expect(p).toContain('ImagePaths: ["/d/ref-1.jpg"]');
    expect(p).toContain('AspectRatio: "16:9"');
    expect(p).toContain("<YEU_CAU>\nĐổi chữ thành MUA 1 TẶNG 1\n</YEU_CAU>");
  });

  it("không có ảnh tham chiếu / tỷ lệ → không nhắc tới", () => {
    const p = buildImagePrompt("icon", [], null);
    expect(p).not.toContain("ImagePaths");
    expect(p).not.toContain("AspectRatio");
  });
});

describe("extractImagePaths", () => {
  it("bắt đường dẫn unix, windows và trong markdown", () => {
    expect(extractImagePaths("/var/lib/penai/.gemini/antigravity-cli/brain/abc/banner_1.jpg\n")).toEqual([
      "/var/lib/penai/.gemini/antigravity-cli/brain/abc/banner_1.jpg",
    ]);
    expect(extractImagePaths("Xong: ![a](/tmp/x/a.png)")).toEqual(["/tmp/x/a.png"]);
    expect(extractImagePaths("C:\\Users\\u\\.gemini\\brain\\a.webp")).toEqual([
      "C:\\Users\\u\\.gemini\\brain\\a.webp",
    ]);
    expect(extractImagePaths("không có ảnh")).toEqual([]);
  });
});

describe("findGeneratedImage", () => {
  let tmp = "";
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("dùng đường dẫn trong response nếu nằm trong thư mục cho phép", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "agy-img-"));
    const conv = path.join(tmp, "brain", "c1");
    await mkdir(conv, { recursive: true });
    const img = path.join(conv, "out.jpg");
    await writeFile(img, "x");
    const found = await findGeneratedImage(
      { status: "SUCCESS", conversation_id: "c1", response: `${img}\n` },
      { dataDir: tmp },
    );
    expect(found).toBe(img);
  });

  it("bỏ qua đường dẫn ngoài thư mục cho phép và ảnh tham chiếu → lấy ảnh mới nhất trong brain/<conv>", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "agy-img-"));
    const conv = path.join(tmp, "brain", "c2");
    const work = path.join(tmp, "work");
    await mkdir(conv, { recursive: true });
    await mkdir(work, { recursive: true });
    const ref = path.join(work, "ref-1.png");
    const older = path.join(conv, "old.png");
    const newer = path.join(conv, "new.jpg");
    await writeFile(ref, "r");
    await writeFile(older, "o");
    await writeFile(newer, "n");
    await utimes(older, new Date(1_000_000), new Date(1_000_000));
    const found = await findGeneratedImage(
      { status: "SUCCESS", conversation_id: "c2", response: `/etc/passwd.png ${ref}` },
      { dataDir: tmp, extraRoots: [work], exclude: [ref] },
    );
    expect(found).toBe(newer);
  });

  it("conversation_id lạ (path traversal) → không tìm", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "agy-img-"));
    const found = await findGeneratedImage(
      { status: "SUCCESS", conversation_id: "../..", response: "" },
      { dataDir: tmp },
    );
    expect(found).toBeNull();
  });
});

describe("sniffImageMime", () => {
  it("nhận diện theo magic bytes", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageMime(Buffer.from("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("hello"))).toBeNull();
  });
});

describe("imageDimensions", () => {
  it("PNG: đọc IHDR", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(0x0d0a1a0a, 4);
    png.writeUInt32BE(1376, 16);
    png.writeUInt32BE(768, 20);
    expect(imageDimensions(png)).toEqual({ width: 1376, height: 768 });
  });

  it("JPEG: bỏ qua APP0, đọc SOF0", () => {
    const jpg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0),
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x05, 0x60, 0x03, ...new Array(12).fill(0),
    ]);
    expect(imageDimensions(jpg)).toEqual({ width: 1376, height: 768 });
  });

  it("không phải ảnh → null; tỷ lệ suy ra đúng khung 16:9", () => {
    expect(imageDimensions(Buffer.from("hello world, not an image at all"))).toBeNull();
    expect(aspectRatioFor(`${1376}x${768}`)).toBe("16:9");
  });
});
