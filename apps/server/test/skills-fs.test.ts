import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { readSkillZip } from "../src/skills-fs.js";

describe("readSkillZip size limits", () => {
  it("accepts a template over 2 MB", () => {
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("---\nname: test\ndescription: test\n---\n"));
    zip.addFile("assets/template.pdf", Buffer.alloc(3 * 1024 * 1024, 65));
    expect(readSkillZip(zip.toBuffer()).files).toHaveLength(1);
  });

  it("rejects a file over 100 MB before decompressing it", () => {
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("---\nname: test\ndescription: test\n---\n"));
    zip.addFile("assets/template.pdf", Buffer.alloc(101 * 1024 * 1024, 65));
    expect(() => readSkillZip(zip.toBuffer())).toThrow(/quá 100MB/);
  });
});
