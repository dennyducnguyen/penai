/**
 * Thư viện file của agent (tiền tố "thu-vien/") + cô lập exec (26/09/2026).
 * Phần sandbox bubblewrap thật chỉ chạy trên Linux có bwrap (VPS); phần còn lại chạy mọi nơi.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  buildBwrapArgs,
  commandHeads,
  bwrapUsable,
  deleteFileTool,
  editFileTool,
  execEnv,
  execTool,
  listFilesTool,
  readFileTool,
  resolveWorkPath,
  resolveWorkPathChecked,
  scrubSecretEnv,
  sendFileTool,
  writeFileTool,
  type FsProbe,
  type ToolContext,
} from "../src/index.js";

const ctx: WorkspaceContext = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "tester",
  role: "ws_admin",
};

let base = "";
let wsDir = "";
let userDir = "";
let sharedDir = "";
let libA = "";
let libB = "";
let tc: ToolContext;
const sent: string[] = [];
const trashed: string[] = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "penai-lib-"));
  wsDir = resolve(base, "ws");
  userDir = resolve(wsDir, "users", "telegram-111");
  sharedDir = resolve(wsDir, "shared");
  libA = resolve(base, "thu-vien", "ws", "agent-a");
  libB = resolve(base, "thu-vien", "ws", "agent-b");
  for (const d of [userDir, sharedDir, libA, libB]) await mkdir(d, { recursive: true });
  await writeFile(join(libA, "mau-bao-gia.md"), "# Mẫu báo giá\nĐơn giá: ...", "utf8");
  await mkdir(join(libA, "hop-dong"), { recursive: true });
  await writeFile(join(libA, "hop-dong", "mau.txt"), "mau hop dong", "utf8");
  await writeFile(join(libB, "bi-mat-b.txt"), "cua agent B", "utf8");
  tc = {
    ctx,
    workspaceDataDir: wsDir,
    workDir: userDir,
    sharedDir,
    libraryDir: libA,
    attachFile: (p) => sent.push(p),
    libraryTrash: async (p) => {
      trashed.push(p);
      await rm(p, { recursive: true, force: true });
    },
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("tiền tố thu-vien/ — thư viện riêng của agent", () => {
  it("đọc + liệt kê file trong thư viện", async () => {
    const txt = await readFileTool.execute({ path: "thu-vien/mau-bao-gia.md" } as never, tc);
    expect(String(txt)).toContain("Mẫu báo giá");
    const list = await listFilesTool.execute({ path: "thu-vien", recursive: true }, tc);
    expect(list).toContain("thu-vien/mau-bao-gia.md");
    expect(list).toContain("thu-vien/hop-dong/mau.txt");
  });

  it("mặc định CHỈ ĐỌC: ghi/sửa/xóa bị từ chối", async () => {
    await expect(
      writeFileTool.execute({ path: "thu-vien/x.txt", content: "a", append: false }, tc),
    ).rejects.toThrow(/chỉ đọc/);
    await expect(
      editFileTool.execute({ path: "thu-vien/mau-bao-gia.md", find: "Đơn", replace: "X", all: false }, tc),
    ).rejects.toThrow(/chỉ đọc/);
    await expect(deleteFileTool.execute({ path: "thu-vien/mau-bao-gia.md", recursive: false }, tc)).rejects.toThrow(/chỉ đọc/);
    expect(await readFile(join(libA, "mau-bao-gia.md"), "utf8")).toContain("Đơn giá");
  });

  it("không đi vòng sang thư viện agent khác / thư mục ngoài", () => {
    expect(() => resolveWorkPath(tc, "thu-vien/../agent-b/bi-mat-b.txt")).toThrow(/Từ chối/);
    expect(() => resolveWorkPath(tc, libB + "/bi-mat-b.txt")).toThrow(/Từ chối/);
    expect(() => resolveWorkPath(tc, "../../../thu-vien/ws/agent-b/bi-mat-b.txt")).toThrow(/Từ chối/);
  });

  it("đường dẫn tuyệt đối trỏ vào thư viện được nhận là thư viện (vẫn chỉ đọc)", () => {
    const r = resolveWorkPath(tc, libA.replaceAll("\\", "/") + "/mau-bao-gia.md");
    expect(r.library).toBe(true);
    expect(r.display).toBe("thu-vien/mau-bao-gia.md");
  });

  it("symlink trong thư viện trỏ ra ngoài bị chặn", async () => {
    try {
      await symlink(libB, join(libA, "lien-ket"), "junction");
    } catch {
      return; // máy không cho tạo symlink — bỏ qua
    }
    await expect(resolveWorkPathChecked(tc, "thu-vien/lien-ket/bi-mat-b.txt")).rejects.toThrow(/Từ chối/);
    await rm(join(libA, "lien-ket"), { force: true, recursive: false }).catch(() => {});
  });

  it("lượt chạy không gắn agent thì không có thu-vien/", () => {
    const noLib: ToolContext = { ...tc };
    delete noLib.libraryDir;
    expect(() => resolveWorkPath(noLib, "thu-vien/mau-bao-gia.md")).toThrow(/không có thư viện/);
  });

  it("send_file từ thư viện gửi BẢN SAO trong thư mục làm việc (không đụng bản gốc)", async () => {
    sent.length = 0;
    const out = await sendFileTool.execute({ path: "thu-vien/hop-dong/mau.txt" }, tc);
    expect(out).toContain("bản sao");
    expect(sent).toHaveLength(1);
    expect(resolve(sent[0]!)).toBe(resolve(userDir, "mau.txt"));
    expect(await readFile(sent[0]!, "utf8")).toBe("mau hop dong");
    // gửi lại cùng file → dùng lại bản sao, không sinh mau-2.txt
    await sendFileTool.execute({ path: "thu-vien/hop-dong/mau.txt" }, tc);
    expect((await readdir(userDir)).filter((n) => n.startsWith("mau"))).toEqual(["mau.txt"]);
  });

  it("bật canWriteLibrary: ghi được, xóa đi qua thùng rác", async () => {
    const w: ToolContext = { ...tc, canWriteLibrary: true };
    await writeFileTool.execute({ path: "thu-vien/ghi-chu.md", content: "agent ghi", append: false }, w);
    expect(await readFile(join(libA, "ghi-chu.md"), "utf8")).toBe("agent ghi");
    const msg = await deleteFileTool.execute({ path: "thu-vien/ghi-chu.md", recursive: false }, w);
    expect(msg).toContain("thùng rác");
    expect(trashed.map((p) => resolve(p))).toContain(resolve(libA, "ghi-chu.md"));
    // không xóa được chính gốc thư viện
    await expect(deleteFileTool.execute({ path: "thu-vien", recursive: true }, w)).rejects.toThrow(/gốc/);
  });

  it("shared/ vẫn chỉ đọc kể cả khi được ghi thư viện", async () => {
    const w: ToolContext = { ...tc, canWriteLibrary: true };
    await expect(
      writeFileTool.execute({ path: "shared/x.txt", content: "a", append: false }, w),
    ).rejects.toThrow(/shared\/ chỉ đọc/);
  });
});

describe("biến môi trường cho lệnh", () => {
  it("execEnv chỉ giữ allowlist — không có bí mật của server", () => {
    const saved = { ...process.env };
    process.env.PENAI_MASTER_KEY = "khoa-bi-mat";
    process.env.DATABASE_URL = "postgresql://u:p@h/db";
    process.env.SOME_API_KEY = "x";
    try {
      const env = execEnv({ homeDir: "/var/lib/penai/data/exec-home/ws/a" });
      expect(env.PENAI_MASTER_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.SOME_API_KEY).toBeUndefined();
      expect(env.HOME).toBe("/var/lib/penai/data/exec-home/ws/a");
      expect(env.PATH).toBeTruthy();
      expect(env.PYTHONIOENCODING).toBe("utf-8");
    } finally {
      process.env = saved;
    }
  });

  it("scrubSecretEnv bỏ khóa/token/mật khẩu, giữ biến thường", () => {
    const out = scrubSecretEnv({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      PENAI_MASTER_KEY: "k",
      PENAI_PUBLIC_URL: "https://x",
      DATABASE_URL: "d",
      OPENAI_API_KEY: "o",
      GITHUB_TOKEN: "g",
      PGPASSWORD: "p",
      MY_SECRET: "s",
    });
    expect(Object.keys(out).sort()).toEqual(["LANG", "PATH"]);
  });

  it("exec không lộ PENAI_MASTER_KEY dù tiến trình server có", async () => {
    const saved = { ...process.env };
    process.env.PENAI_MASTER_KEY = "khoa-that-khong-duoc-lo";
    try {
      const out = await execTool.execute({ command: "env" }, { ...tc, requestApproval: async () => true });
      expect(out).not.toContain("khoa-that-khong-duoc-lo");
      expect(out).not.toContain("PENAI_MASTER_KEY");
    } finally {
      process.env = saved;
    }
  });
});

describe("phân tích lệnh: chuyển hướng không phải lệnh mới", () => {
  it("2>&1, >&2, &> không tách ra lệnh lạ; && và & vẫn tách", () => {
    expect(commandHeads("ls /x 2>&1")).toEqual(["ls"]);
    expect(commandHeads("python3 a.py 2>&1 | tail -5")).toEqual(["python3", "tail"]);
    expect(commandHeads("echo loi >&2")).toEqual(["echo"]);
    expect(commandHeads("node b.js &> log.txt")).toEqual(["node"]);
    expect(commandHeads("cat a && curlx b")).toEqual(["cat", "curlx"]);
    expect(commandHeads("sleep 1 & nc -l 9")).toEqual(["sleep", "nc"]);
  });
});

describe("tham số bubblewrap (thuần)", () => {
  const probe: FsProbe = {
    exists: (p) => ["/etc/penai", "/opt/node24", "/opt/pnpm11", "/var/lib/penai/data/ws/shared", "/var/lib/penai/data/thu-vien/ws/a"].includes(p),
    symlinkTarget: (p) => ({ "/bin": "usr/bin", "/lib": "usr/lib", "/lib64": "usr/lib64", "/sbin": "usr/sbin" } as Record<string, string>)[p] ?? null,
    realpath: (p) => (p === "/etc/resolv.conf" ? "/run/resolvconf/resolv.conf" : p),
  };
  const mounts = {
    workDir: "/var/lib/penai/data/ws/users/telegram-1",
    sharedDir: "/var/lib/penai/data/ws/shared",
    libraryDir: "/var/lib/penai/data/thu-vien/ws/a",
    homeDir: "/var/lib/penai/data/exec-home/ws/a",
    tmpDir: "/var/lib/penai/data/exec-home/ws/a/.sandbox-tmp",
    pathEnv: "/opt/node24/bin:/opt/pnpm11/bin:/usr/local/bin:/usr/bin:/bin",
  };
  const pairs = (args: string[], flag: string) =>
    args.flatMap((a, i) => (a === flag ? [`${args[i + 1]} -> ${args[i + 2]}`] : []));

  it("cây tối thiểu: không bind / và không bind /var/lib/penai", () => {
    const a = buildBwrapArgs(mounts, probe);
    expect(a).toContain("--unshare-pid");
    expect(a).toContain("--die-with-parent");
    expect(pairs(a, "--bind").some((p) => p.startsWith("/ ->"))).toBe(false);
    expect(pairs(a, "--ro-bind").some((p) => p.startsWith("/var/lib/penai ->") || p.startsWith("/ ->"))).toBe(false);
    expect(pairs(a, "--ro-bind")).toContain("/usr -> /usr");
    expect(pairs(a, "--ro-bind")).toContain("/etc -> /etc");
    expect(pairs(a, "--symlink")).toContain("usr/bin -> /bin");
    expect(a.join(" ")).toContain("--tmpfs /etc/penai");
    expect(pairs(a, "--ro-bind")).toContain("/run/resolvconf -> /run/resolvconf");
    expect(pairs(a, "--ro-bind")).toContain("/opt/node24 -> /opt/node24");
    expect(pairs(a, "--ro-bind")).toContain("/opt/pnpm11 -> /opt/pnpm11");
  });

  it("workDir ghi được; shared chỉ đọc bind SAU workDir; thư viện theo quyền", () => {
    const a = buildBwrapArgs(mounts, probe);
    const iWork = a.indexOf(mounts.workDir);
    const iShared = a.lastIndexOf(mounts.sharedDir);
    expect(a[iWork - 1]).toBe("--bind");
    expect(a[iShared - 2]).toBe("--ro-bind");
    expect(iShared).toBeGreaterThan(iWork);
    expect(pairs(a, "--ro-bind")).toContain(`${mounts.libraryDir} -> ${mounts.libraryDir}`);
    const w = buildBwrapArgs({ ...mounts, libraryWritable: true }, probe);
    expect(pairs(w, "--bind")).toContain(`${mounts.libraryDir} -> ${mounts.libraryDir}`);
    expect(pairs(a, "--bind")).toContain(`${mounts.tmpDir} -> /tmp`);
    expect(a.slice(-3)).toEqual(["/", "--chdir", mounts.workDir]);
  });
});

// ===== Sandbox thật (Linux + bubblewrap) =====
const canBwrap = process.platform === "linux" && bwrapUsable().ok;

describe.skipIf(!canBwrap)("exec trong bubblewrap (máy thật)", () => {
  let root = "";
  let sb: ToolContext;
  const run = (command: string, t: ToolContext = sb) =>
    execTool.execute({ command }, { ...t, requestApproval: async () => true });

  beforeAll(async () => {
    // KHÔNG đặt dưới /tmp: sandbox bind /tmp riêng, dễ nhầm với thư mục test.
    root = await mkdtemp(join(process.cwd(), ".sandbox-test-"));
    const ws = join(root, "data", "ws");
    const u = join(ws, "users", "telegram-9");
    const sh = join(ws, "shared");
    const lib = join(root, "data", "thu-vien", "ws", "agent-a");
    const libOther = join(root, "data", "thu-vien", "ws", "agent-b");
    const other = join(ws, "users", "telegram-khac");
    for (const d of [u, sh, lib, libOther, other]) await mkdir(d, { recursive: true });
    await writeFile(join(sh, "chung.txt"), "chung", "utf8");
    await writeFile(join(lib, "mau.txt"), "mau", "utf8");
    await writeFile(join(libOther, "b.txt"), "bi mat agent b", "utf8");
    await writeFile(join(other, "rieng.txt"), "bi mat nguoi khac", "utf8");
    await writeFile(join(root, "token.json"), "token-that", "utf8");
    sb = {
      ctx,
      workspaceDataDir: ws,
      workDir: u,
      sharedDir: sh,
      libraryDir: lib,
      execSandbox: { mode: "required", homeDir: join(root, "data", "exec-home", "ws", "agent-a") },
    };
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("chạy được python/node, ghi được thư mục làm việc", async () => {
    const out = await run('python3 -c "print(6*7)" && node -e "console.log(40+2)" && echo ok > ra.txt && cat ra.txt');
    expect(out).toContain("42");
    expect(out).toContain("ok");
  });

  it("đọc được shared + thư viện (đường dẫn tuyệt đối), KHÔNG ghi được", async () => {
    const out = await run(`cat ${sb.sharedDir}/chung.txt ${sb.libraryDir}/mau.txt; touch ${sb.sharedDir}/x 2>&1; touch ${sb.libraryDir}/x 2>&1; echo done`);
    expect(out).toContain("chung");
    expect(out).toContain("mau");
    expect(out).toMatch(/Read-only file system/);
    expect(out).toContain("done");
  });

  it("không thấy thư viện agent khác, thư mục người dùng khác, file ngoài vùng", async () => {
    const out = await run(
      `cat ${join(root, "data", "thu-vien", "ws", "agent-b", "b.txt")} 2>&1; cat ${join(sb.workspaceDataDir, "users", "telegram-khac", "rieng.txt")} 2>&1; cat ${join(root, "token.json")} 2>&1; ls /var/lib/penai 2>&1; cat /etc/penai/penai.env 2>&1; echo end`,
    );
    expect(out).not.toContain("bi mat agent b");
    expect(out).not.toContain("bi mat nguoi khac");
    expect(out).not.toContain("token-that");
    expect(out).toContain("end");
  });

  it("không thấy tiến trình server qua /proc", async () => {
    const out = await run("ls /proc | grep -E '^[0-9]+$' | wc -l; cat /proc/1/cmdline | tr '\\0' ' '");
    const n = Number(out.trim().split(/\s+/)[0]);
    expect(n).toBeLessThan(10);
    expect(out).not.toContain("vitest");
  });

  it("bật ghi thư viện → touch được", async () => {
    const out = await run(`touch ${sb.libraryDir}/moi.txt && echo ok`, { ...sb, canWriteLibrary: true });
    expect(out).toContain("ok");
  });
});
