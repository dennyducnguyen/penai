import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { updateSkillTool } from "../src/builtin/skills.js";
import {
  getLandingPageTool,
  listLandingPagesTool,
  saveLandingPageTool,
} from "../src/builtin/landing-pages.js";
import type { ToolContext } from "../src/registry.js";

const baseCtx = (dir: string): ToolContext => ({
  ctx: { workspaceId: "00000000-0000-0000-0000-000000000001", userId: "u", role: "ws_admin" },
  workspaceDataDir: dir,
});

describe("update_skill", () => {
  it("doc file nguoi dung gui, gui dung upsert/delete va SKILL.md moi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "penai-skill-update-"));
    await writeFile(join(dir, "logo.png"), Buffer.from([1, 2, 3]));
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: Noi dung\ndescription: Huong dan noi dung\n---\n# Moi",
    );
    let captured: {
      content?: string;
      upsertFiles: Array<{ path: string; contentB64: string }>;
      deleteFiles: string[];
    } | undefined;
    const update = vi.fn(async (input: typeof captured) => {
      captured = input;
      return "ok";
    });
    const ctx: ToolContext = { ...baseCtx(dir), skills: { search: vi.fn(), get: vi.fn(), update } };
    const out = await updateSkillTool.execute(
      {
        slug: "noi-dung",
        skillMdSourcePath: "SKILL.md",
        upsertFiles: [{ path: "references/logo.png", sourcePath: "logo.png" }],
        deleteFiles: ["references/logo-cu.png"],
      },
      ctx,
    );
    expect(out).toBe("ok");
    expect(update).toHaveBeenCalledOnce();
    expect(captured?.content).toContain("# Moi");
    expect(captured?.upsertFiles[0]).toEqual({
      path: "references/logo.png",
      contentB64: Buffer.from([1, 2, 3]).toString("base64"),
    });
    expect(captured?.deleteFiles).toEqual(["references/logo-cu.png"]);
  });

  it("chan path dich traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "penai-skill-update-"));
    await writeFile(join(dir, "x.txt"), "x");
    const ctx: ToolContext = {
      ...baseCtx(dir),
      skills: { search: vi.fn(), get: vi.fn(), update: vi.fn() },
    };
    await expect(
      updateSkillTool.execute(
        {
          slug: "x",
          upsertFiles: [{ path: "../evil.txt", sourcePath: "x.txt" }],
          deleteFiles: [],
        },
        ctx,
      ),
    ).rejects.toThrow(/khong hop le/i);
  });
});

describe("landing page tools", () => {
  it("save/list/get va xuat HTML ve workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "penai-landing-"));
    const html = "<!doctype html><html><body><script>document.body.dataset.ok='1'</script></body></html>";
    await writeFile(join(dir, "page.html"), html);
    let savedSlug = "";
    const save = vi.fn(async (input: { slug: string }) => {
      savedSlug = input.slug;
      return "https://penai.example/landing/id/demo";
    });
    const list = vi.fn(async () => "demo | Demo");
    const get = vi.fn(async () => ({
      html,
      url: "https://penai.example/landing/id/demo",
      title: "Demo",
      version: 2,
    }));
    const ctx: ToolContext = { ...baseCtx(dir), landingPages: { save, list, get } };

    await expect(
      saveLandingPageTool.execute(
        { slug: "Demo Landing", title: "Demo", sourcePath: "page.html" },
        ctx,
      ),
    ).resolves.toContain("/landing/");
    expect(savedSlug).toBe("demo-landing");
    await expect(listLandingPagesTool.execute({}, ctx)).resolves.toContain("demo");
    const out = await getLandingPageTool.execute({ slug: "demo" }, ctx);
    expect(out).toContain("v2");
    expect(await readFile(join(dir, "landing-pages", "demo.html"), "utf8")).toBe(html);
  });
});
