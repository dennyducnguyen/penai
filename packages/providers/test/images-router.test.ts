import { describe, expect, it } from "vitest";
import { ImageRouter, sizeForAspect, type ImageBackend } from "../src/images/index.js";

type Impl = () => Promise<{ data: Buffer; mime: string }>;

function backend(name: string, provider: string, impl: Impl, calls: string[]): ImageBackend {
  return {
    name,
    provider,
    generate: async () => {
      calls.push(name);
      return impl();
    },
  };
}

const ok: Impl = async () => ({ data: Buffer.from("x"), mime: "image/png" });
const fail =
  (msg: string, extra: Record<string, unknown> = {}): Impl =>
  async () => {
    throw Object.assign(new Error(msg), extra);
  };

describe("ImageRouter", () => {
  it("dùng backend đầu tiên khi thành công", async () => {
    const calls: string[] = [];
    const r = new ImageRouter([
      backend("antigravity/m", "antigravity", ok, calls),
      backend("codex/gpt-image-2", "codex", ok, calls),
    ]);
    const img = await r.generate({ prompt: "p" });
    expect(img.route).toBe("antigravity/m");
    expect(calls).toEqual(["antigravity/m"]);
  });

  it("backend lỗi → sang backend kế", async () => {
    const calls: string[] = [];
    const r = new ImageRouter([
      backend("antigravity/m", "antigravity", fail("agy hỏng"), calls),
      backend("codex/gpt-image-2", "codex", ok, calls),
    ]);
    const img = await r.generate({ prompt: "p" });
    expect(img.route).toBe("codex/gpt-image-2");
    expect(calls).toEqual(["antigravity/m", "codex/gpt-image-2"]);
  });

  it("backend bận xếp sau backend rảnh", async () => {
    const calls: string[] = [];
    const r = new ImageRouter(
      [
        backend("antigravity/m", "antigravity", ok, calls),
        backend("codex/gpt-image-2", "codex", ok, calls),
      ],
      { isBusy: (b) => b.provider === "antigravity" },
    );
    expect((await r.generate({ prompt: "p" })).route).toBe("codex/gpt-image-2");
    expect(calls).toEqual(["codex/gpt-image-2"]);
  });

  it("mọi backend bận → giữ thứ tự gốc", async () => {
    const calls: string[] = [];
    const r = new ImageRouter(
      [
        backend("antigravity/m", "antigravity", ok, calls),
        backend("codex/gpt-image-2", "codex", ok, calls),
      ],
      { isBusy: () => true },
    );
    expect((await r.generate({ prompt: "p" })).route).toBe("antigravity/m");
  });

  it("mọi backend hỏng → gộp lỗi từng route, giữ status lỗi cuối", async () => {
    const r = new ImageRouter([
      backend("antigravity/m", "antigravity", fail("agy hỏng"), []),
      backend("codex/gpt-image-2", "codex", fail("hết quota", { status: 429 }), []),
    ]);
    const err = (await r.generate({ prompt: "p" }).catch((e) => e)) as Error & { status?: number };
    expect(err.message).toContain("antigravity/m: agy hỏng");
    expect(err.message).toContain("codex/gpt-image-2: hết quota");
    expect(err.status).toBe(429);
  });

  it("chỉ lỗi hàng đợi → ném nguyên QueueRejectedError (API trả 429)", async () => {
    const queueErr = Object.assign(new Error("Chờ quá 30s"), { name: "QueueRejectedError" });
    const r = new ImageRouter([
      { name: "a", provider: "antigravity", generate: async () => Promise.reject(queueErr) },
      { name: "c", provider: "codex", generate: async () => Promise.reject(queueErr) },
    ]);
    await expect(r.generate({ prompt: "p" })).rejects.toBe(queueErr);
  });

  it("run bọc từng lần gọi backend theo provider", async () => {
    const wrapped: string[] = [];
    const r = new ImageRouter(
      [
        backend("antigravity/m", "antigravity", fail("x"), []),
        backend("codex/gpt-image-2", "codex", ok, []),
      ],
      {
        run: async (b, fn) => {
          wrapped.push(b.provider);
          return fn();
        },
      },
    );
    await r.generate({ prompt: "p" });
    expect(wrapped).toEqual(["antigravity", "codex"]);
  });

  it("only() lọc đúng provider, không có thì báo rõ", async () => {
    const calls: string[] = [];
    const r = new ImageRouter([
      backend("antigravity/m", "antigravity", ok, calls),
      backend("codex/gpt-image-2", "codex", ok, calls),
    ]);
    expect((await r.only("codex").generate({ prompt: "p" })).route).toBe("codex/gpt-image-2");
    expect(calls).toEqual(["codex/gpt-image-2"]);
    expect(() => r.only("claude-code")).toThrow(/claude-code/);
  });
});

describe("sizeForAspect", () => {
  it("quy tỷ lệ về size codex", () => {
    expect(sizeForAspect("16:9")).toBe("1536x1024");
    expect(sizeForAspect("9:16")).toBe("1024x1536");
    expect(sizeForAspect("4:5")).toBe("1024x1536");
    expect(sizeForAspect("1:1")).toBe("1024x1024");
    expect(sizeForAspect("abc")).toBeUndefined();
    expect(sizeForAspect(undefined)).toBeUndefined();
  });
});
