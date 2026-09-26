import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { PenaiConfigSchema } from "@penai/shared";
import { createDb, type DbHandle } from "@penai/db";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "@penai/db/testing";
import { createProviderRegistry } from "@penai/providers";
import { createDefaultToolRegistry } from "@penai/tools";
import { buildApp } from "../src/app.js";
import { readSkillZip, sanitizeSkillPath } from "../src/skills-fs.js";

let fx: TestFixtures;
let dbh: DbHandle;
let app: FastifyInstance;
let dataDir: string;

const auth = () => ({ authorization: `Bearer ${fx.keys.aAdmin}` });

function makeZip(entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [p, content] of Object.entries(entries)) {
    zip.addFile(p, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer().toString("base64");
}

const SKILL_MD =
  "---\nname: Báo cáo tuần\ndescription: Hướng dẫn tạo báo cáo tuần chuẩn phòng ban\n---\n\n# Cách làm\nChạy script scripts/report.py";

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  dataDir = await mkdtemp(join(tmpdir(), "penai-skills-"));
  const config = PenaiConfigSchema.parse({
    dataDir,
    providers: { default: { kind: "openai-compat", baseURL: "http://127.0.0.1:1" } },
  });
  app = buildApp({
    db: dbh,
    providers: createProviderRegistry(config.providers),
    tools: createDefaultToolRegistry(),
    config,
  });
});

afterAll(async () => {
  await app.close();
  await dbh.close();
});

describe("sanitizeSkillPath (chống zip-slip)", () => {
  it("nhận path sạch, chuẩn hóa backslash", () => {
    expect(sanitizeSkillPath("scripts\\report.py")).toBe("scripts/report.py");
    expect(sanitizeSkillPath("./references/mau.md")).toBe("references/mau.md");
  });
  it("chặn traversal / tuyệt đối / ẩn", () => {
    expect(sanitizeSkillPath("../ngoai.txt")).toBeNull();
    expect(sanitizeSkillPath("a/../../b")).toBeNull();
    expect(sanitizeSkillPath("/etc/passwd")).toBeNull();
    expect(sanitizeSkillPath("C:/Windows/x")).toBeNull();
    expect(sanitizeSkillPath(".env")).toBeNull();
    expect(sanitizeSkillPath("node_modules/x.js")).toBeNull();
  });
});

describe("readSkillZip", () => {
  it("SKILL.md trong 1 thư mục cấp 1 → bỏ tiền tố", () => {
    const b64 = makeZip({
      "bao-cao/SKILL.md": SKILL_MD,
      "bao-cao/scripts/report.py": "print('ok')",
    });
    const p = readSkillZip(Buffer.from(b64, "base64"));
    expect(p.skillMd).toContain("Báo cáo tuần");
    expect(p.files.map((f) => f.path)).toEqual(["scripts/report.py"]);
  });
  it("không có SKILL.md → lỗi rõ", () => {
    const b64 = makeZip({ "x.txt": "1" });
    expect(() => readSkillZip(Buffer.from(b64, "base64"))).toThrow(/SKILL\.md/);
  });
});

describe("Skills e2e: ZIP import → files → versions → grants → export", () => {
  let skillId = "";

  it("nạp ZIP tạo skill mới + materialize ra đĩa", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills/import",
      headers: auth(),
      payload: {
        zipBase64: makeZip({
          "SKILL.md": SKILL_MD,
          "scripts/report.py": "print('bao cao')",
          "references/mau.md": "# Mẫu",
        }),
      },
    });
    expect(res.statusCode).toBe(201);
    const j = res.json();
    skillId = j.skill.id;
    expect(j.skill.slug).toBe("bao-cao-tuan");
    expect(j.fileCount).toBe(2);
    // materialize: agent thấy tại shared/skills/<slug>/
    const disk = join(dataDir, fx.wsA, "shared", "skills", "bao-cao-tuan");
    expect(existsSync(join(disk, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(disk, "scripts", "report.py"), "utf8")).toBe("print('bao cao')");
  });

  it("nạp lại ZIP trùng slug → ghi đè + bump version + snapshot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills/import",
      headers: auth(),
      payload: {
        zipBase64: makeZip({
          "SKILL.md": SKILL_MD + "\n\nBản mới hơn.",
          "scripts/report.py": "print('v2')",
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().overwritten).toBe(true);
    expect(res.json().skill.version).toBe(2);
    const vs = (
      await app.inject({ method: "GET", url: `/v1/skills/${skillId}/versions`, headers: auth() })
    ).json().versions;
    expect(vs.length).toBe(1);
    expect(vs[0].version).toBe(1);
    expect(vs[0].fileCount).toBe(2);
  });

  it("sửa file văn bản qua API → version tăng, đĩa cập nhật", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/v1/skills/${skillId}/files`,
      headers: auth(),
      payload: { path: "scripts/report.py", content: "print('v3 da sua')" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(3);
    const disk = join(dataDir, fx.wsA, "shared", "skills", "bao-cao-tuan");
    expect(readFileSync(join(disk, "scripts", "report.py"), "utf8")).toBe("print('v3 da sua')");
  });

  it("khôi phục v1 → nội dung + files quay lại, đĩa dựng lại", async () => {
    const vs = (
      await app.inject({ method: "GET", url: `/v1/skills/${skillId}/versions`, headers: auth() })
    ).json().versions;
    const v1 = vs.find((v: { version: number }) => v.version === 1);
    const res = await app.inject({
      method: "POST",
      url: `/v1/skills/versions/${v1.id}/restore`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fromVersion).toBe(1);
    const disk = join(dataDir, fx.wsA, "shared", "skills", "bao-cao-tuan");
    expect(readFileSync(join(disk, "scripts", "report.py"), "utf8")).toBe("print('bao cao')");
    expect(existsSync(join(disk, "references", "mau.md"))).toBe(true);
  });

  it("phân quyền: list agents + grant kèm canManage + revoke", async () => {
    let agents = (
      await app.inject({ method: "GET", url: `/v1/skills/${skillId}/agents`, headers: auth() })
    ).json().agents;
    expect(agents.length).toBe(1);
    expect(agents[0].granted).toBe(false);

    await app.inject({
      method: "POST",
      url: `/v1/skills/${skillId}/grants/agent`,
      headers: auth(),
      payload: { agentId: fx.agentA, canManage: true },
    });
    agents = (
      await app.inject({ method: "GET", url: `/v1/skills/${skillId}/agents`, headers: auth() })
    ).json().agents;
    expect(agents[0].granted).toBe(true);
    expect(agents[0].canManage).toBe(true);

    // grant lại hạ canManage → phải cập nhật (không phải DoNothing)
    await app.inject({
      method: "POST",
      url: `/v1/skills/${skillId}/grants/agent`,
      headers: auth(),
      payload: { agentId: fx.agentA, canManage: false },
    });
    agents = (
      await app.inject({ method: "GET", url: `/v1/skills/${skillId}/agents`, headers: auth() })
    ).json().agents;
    expect(agents[0].canManage).toBe(false);

    await app.inject({
      method: "DELETE",
      url: `/v1/skills/${skillId}/grants/agent/${fx.agentA}`,
      headers: auth(),
    });
    agents = (
      await app.inject({ method: "GET", url: `/v1/skills/${skillId}/agents`, headers: auth() })
    ).json().agents;
    expect(agents[0].granted).toBe(false);
  });

  it("export ZIP tải về được và mở lại đúng nội dung", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/skills/${skillId}/export`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    const zip = new AdmZip(res.rawPayload);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("SKILL.md");
    expect(names).toContain("scripts/report.py");
  });

  it("xóa skill → thư mục trên đĩa cũng mất", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/skills/${skillId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(dataDir, fx.wsA, "shared", "skills", "bao-cao-tuan"))).toBe(false);
  });

  it("viewer không được nạp ZIP (cần ws_admin)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills/import",
      headers: { authorization: `Bearer ${fx.keys.aViewer}` },
      payload: { zipBase64: makeZip({ "SKILL.md": SKILL_MD }) },
    });
    expect(res.statusCode).toBe(403);
  });
});
