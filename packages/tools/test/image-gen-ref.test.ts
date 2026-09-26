import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { imageGenTool } from "../src/builtin/image-gen.js";
import type { ToolContext } from "../src/registry.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type Call = { prompt: string; size?: string; refImages?: string[]; provider?: string; aspectRatio?: string };

async function makeCtx(result: { mime?: string; route?: string } = {}): Promise<{
  toolCtx: ToolContext;
  calls: Call[];
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "penai-imggen-"));
  const calls: Call[] = [];
  const toolCtx: ToolContext = {
    ctx: { workspaceId: "ws", userId: "u", role: "ws_admin" },
    workspaceDataDir: dir,
    generateImage: async (req) => {
      calls.push({
        prompt: req.prompt,
        ...(req.size ? { size: req.size } : {}),
        ...(req.refImages ? { refImages: req.refImages } : {}),
        ...(req.provider ? { provider: req.provider } : {}),
        ...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
      });
      return {
        data: PNG_1PX,
        mime: result.mime ?? "image/png",
        ...(result.route ? { route: result.route } : {}),
      };
    },
  };
  return { toolCtx, calls, dir };
}

describe("image_generation + refImages (ảnh người dùng gửi làm ảnh mẫu)", () => {
  it("đọc refImages trong workspace → truyền data URL xuống provider", async () => {
    const { toolCtx, calls, dir } = await makeCtx();
    await writeFile(join(dir, "anh-nhan-1.jpg"), PNG_1PX);
    await writeFile(join(dir, "anh-nhan-2.png"), PNG_1PX);

    const out = await imageGenTool.execute(
      {
        prompt: "ghép 2 chai thành ảnh quảng cáo",
        size: "1024x1024",
        filename: "quangcao.png",
        provider: "auto",
        refImages: ["anh-nhan-1.jpg", "anh-nhan-2.png"],
      },
      toolCtx,
    );
    expect(out).toContain("[[media:");
    expect(calls.length).toBe(1);
    expect(calls[0]!.refImages).toHaveLength(2);
    expect(calls[0]!.refImages![0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(calls[0]!.refImages![1]).toMatch(/^data:image\/png;base64,/);
  });

  it("không có refImages → gọi provider không kèm ảnh (giữ hành vi cũ)", async () => {
    const { toolCtx, calls } = await makeCtx();
    await imageGenTool.execute(
      { prompt: "một chú mèo", size: "1024x1024", filename: "meo.png", provider: "auto" },
      toolCtx,
    );
    expect(calls[0]!.refImages).toBeUndefined();
    expect(calls[0]!.provider).toBeUndefined();
  });

  it("refImages thoát jail → từ chối", async () => {
    const { toolCtx } = await makeCtx();
    await expect(
      imageGenTool.execute(
        { prompt: "x", size: "1024x1024", filename: "x.png", provider: "auto", refImages: ["../../etc/passwd"] },
        toolCtx,
      ),
    ).rejects.toThrow(/ngoài|Không đọc được/);
  });

  it("refImage không tồn tại → lỗi rõ ràng cho model sửa", async () => {
    const { toolCtx } = await makeCtx();
    await expect(
      imageGenTool.execute(
        { prompt: "x", size: "1024x1024", filename: "x.png", provider: "auto", refImages: ["khong-co.jpg"] },
        toolCtx,
      ),
    ).rejects.toThrow(/Không đọc được ảnh tham chiếu/);
  });
});

describe("image_generation — chọn provider + định dạng file", () => {
  it("provider=codex + aspectRatio được chuyển xuống runtime", async () => {
    const { toolCtx, calls } = await makeCtx();
    await imageGenTool.execute(
      { prompt: "banner", size: "1024x1024", filename: "b.png", provider: "codex", aspectRatio: "16:9" },
      toolCtx,
    );
    expect(calls[0]!.provider).toBe("codex");
    expect(calls[0]!.aspectRatio).toBe("16:9");
  });

  it("ảnh JPEG (agy) → đổi đuôi .jpg và báo route", async () => {
    const { toolCtx } = await makeCtx({ mime: "image/jpeg", route: "antigravity/gemini-3.7-flash-low" });
    const out = await imageGenTool.execute(
      { prompt: "banner", size: "1024x1024", filename: "banner.png", provider: "auto" },
      toolCtx,
    );
    expect(out).toContain("Đã tạo ảnh: banner.jpg (qua antigravity/gemini-3.7-flash-low)");
    expect(out).toMatch(/\[\[media:.*banner\.jpg\]\]/);
  });

  it("publish=true → trả URL ảnh trực tiếp để nhúng landing page", async () => {
    const { toolCtx } = await makeCtx();
    toolCtx.publishFile = async (_path, opts) => ({
      url: "https://penai.example/f/image-token",
      expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000).toISOString(),
    });
    const out = await imageGenTool.execute(
      { prompt: "hero", filename: "hero.png", provider: "auto", publish: true },
      toolCtx,
    );
    expect(out).toContain("URL ảnh trực tiếp");
    expect(out).toContain("https://penai.example/f/image-token");
  });
});

describe("image_generation — size mặc định", () => {
  it("có refImages, không ghi size → không ép size (provider giữ khung ảnh gốc)", async () => {
    const { toolCtx, calls, dir } = await makeCtx();
    await writeFile(join(dir, "banner.jpg"), PNG_1PX);
    await imageGenTool.execute(
      { prompt: "đổi chữ", filename: "b.png", provider: "auto", refImages: ["banner.jpg"] },
      toolCtx,
    );
    expect(calls[0]!.size).toBeUndefined();
  });

  it("tạo mới, không ghi size → 1024x1024 như cũ", async () => {
    const { toolCtx, calls } = await makeCtx();
    await imageGenTool.execute({ prompt: "mèo", filename: "m.png", provider: "auto" }, toolCtx);
    expect(calls[0]!.size).toBe("1024x1024");
  });
});
