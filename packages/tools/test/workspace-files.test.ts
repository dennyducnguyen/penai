import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  listFilesTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  deleteFileTool,
  makeDirTool,
  sendFileTool,
  readFileTool,
  execTool,
  commandHeads,
  resolveWorkPath,
  confineMediaPath,
  ensureWorkDirs,
  type ToolContext,
} from "../src/index.js";

const ctx: WorkspaceContext = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "tester",
  role: "ws_admin",
};

let root = "";
let userA: ToolContext;
let userB: ToolContext;
const sent: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "penai-ws-"));
  const shared = resolve(root, "shared");
  const dirA = resolve(root, "users", "telegram-111");
  const dirB = resolve(root, "users", "telegram-222");
  await ensureWorkDirs(dirA, shared);
  await ensureWorkDirs(dirB, shared);
  await writeFile(join(shared, "AGENT.md"), "# chung\nquy uoc chung", "utf8");
  userA = {
    ctx,
    workspaceDataDir: root,
    workDir: dirA,
    sharedDir: shared,
    attachFile: (p) => sent.push(p),
  };
  userB = { ctx, workspaceDataDir: root, workDir: dirB, sharedDir: shared };
});

describe("thư mục làm việc riêng từng người dùng", () => {
  it("file người dùng A không lọt sang B", async () => {
    await writeFileTool.execute(
      { path: "bi-mat.txt", content: "so tai khoan cua A", append: false },
      userA,
    );
    const listA = await listFilesTool.execute({ path: ".", recursive: false }, userA);
    expect(listA).toContain("bi-mat.txt");

    const listB = await listFilesTool.execute({ path: ".", recursive: false }, userB);
    expect(listB).not.toContain("bi-mat.txt");

    await expect(
      readFileTool.execute({ path: "bi-mat.txt" }, userB),
    ).rejects.toThrow(/Không tìm thấy/);
  });

  it("chặn traversal ra ngoài thư mục riêng", async () => {
    expect(() => resolveWorkPath(userA, "../telegram-222/bi-mat.txt")).toThrow(
      /ngoài thư mục làm việc/,
    );
    expect(() => resolveWorkPath(userA, "../../../etc/passwd")).toThrow();
    await expect(
      writeFileTool.execute({ path: "../../hack.txt", content: "x", append: false }, userA),
    ).rejects.toThrow(/ngoài thư mục làm việc/);
  });

  it("đọc được file dùng chung, nhưng không ghi đè được", async () => {
    const shared = await readFileTool.execute({ path: "shared/AGENT.md" }, userB);
    expect(shared).toContain("quy uoc chung");
    await expect(
      writeFileTool.execute({ path: "shared/AGENT.md", content: "pha hoai", append: false }, userA),
    ).rejects.toThrow(/chỉ đọc/);
  });

  it("không lách được bảo vệ shared bằng '..' hoặc dấu backslash", async () => {
    // workDir = gốc workspace (chat HTTP/cron) → shared/ nằm BÊN TRONG workDir
    const legacy: ToolContext = {
      ctx,
      workspaceDataDir: root,
      workDir: root,
      sharedDir: resolve(root, "shared"),
    };
    // đi vòng qua ".." vẫn phải bị nhận là vùng dùng chung
    await expect(
      writeFileTool.execute(
        { path: "users/../shared/AGENT.md", content: "pha hoai", append: false },
        legacy,
      ),
    ).rejects.toThrow(/chỉ đọc/);
    // dấu backslash cũng không lách được
    await expect(
      writeFileTool.execute(
        { path: "shared\\AGENT.md", content: "pha hoai", append: false },
        legacy,
      ),
    ).rejects.toThrow(/chỉ đọc/);
    // nội dung file chung không đổi
    expect(await readFileTool.execute({ path: "shared/AGENT.md" }, legacy)).toContain(
      "quy uoc chung",
    );
  });

  it("cho ghi shared khi được cấp quyền", async () => {
    const admin: ToolContext = { ...userA, canWriteShared: true };
    const res = await writeFileTool.execute(
      { path: "shared/ghi-chu.md", content: "ok", append: false },
      admin,
    );
    expect(res).toContain("shared/ghi-chu.md");
  });
});

describe("bộ tool file", () => {
  it("edit_file thay chuỗi, báo lỗi khi trùng nhiều", async () => {
    await writeFileTool.execute(
      { path: "note.md", content: "xin chao\nxin chao", append: false },
      userA,
    );
    await expect(
      editFileTool.execute({ path: "note.md", find: "xin chao", replace: "hello", all: false }, userA),
    ).rejects.toThrow(/2 lần/);
    await editFileTool.execute(
      { path: "note.md", find: "xin chao", replace: "hello", all: true },
      userA,
    );
    expect(await readFileTool.execute({ path: "note.md" }, userA)).toBe("hello\nhello");
  });

  it("edit_file không diễn giải $& $1 trong nội dung thay thế", async () => {
    await writeFileTool.execute({ path: "gia.md", content: "Gia: XXX", append: false }, userA);
    await editFileTool.execute(
      { path: "gia.md", find: "XXX", replace: "100$& USD $1 $'", all: false },
      userA,
    );
    // phải giữ NGUYÊN văn, không bị thay bằng chuỗi khớp
    expect(await readFileTool.execute({ path: "gia.md" }, userA)).toBe("Gia: 100$& USD $1 $'");
  });

  it("append nối nội dung", async () => {
    await writeFileTool.execute({ path: "log.txt", content: "dong 1\n", append: false }, userA);
    await writeFileTool.execute({ path: "log.txt", content: "dong 2\n", append: true }, userA);
    expect(await readFileTool.execute({ path: "log.txt" }, userA)).toBe("dong 1\ndong 2\n");
  });

  it("make_dir + move_file + delete_file", async () => {
    await makeDirTool.execute({ path: "tai-lieu" }, userA);
    await moveFileTool.execute({ from: "note.md", to: "tai-lieu/note.md" }, userA);
    const list = await listFilesTool.execute({ path: ".", recursive: true }, userA);
    expect(list).toContain("tai-lieu/note.md");
    await deleteFileTool.execute({ path: "tai-lieu/note.md", recursive: false }, userA);
    await expect(readFileTool.execute({ path: "tai-lieu/note.md" }, userA)).rejects.toThrow();
  });

  it("send_file báo cho kênh gửi file", async () => {
    await writeFileTool.execute({ path: "bao-cao.txt", content: "noi dung", append: false }, userA);
    const res = await sendFileTool.execute({ path: "bao-cao.txt" }, userA);
    expect(res).toContain("Đã gửi file");
    expect(sent.some((p) => p.endsWith("bao-cao.txt"))).toBe(true);
  });

  it("send_file từ chối file không tồn tại", async () => {
    await expect(sendFileTool.execute({ path: "khong-co.txt" }, userA)).rejects.toThrow(
      /Không tìm thấy/,
    );
  });
});

describe("exec trong thư mục riêng", () => {
  it("lệnh trong allowlist chạy không cần phê duyệt, cwd là thư mục riêng", async () => {
    const out = await execTool.execute(
      { command: "echo xin-chao > tu-exec.txt && cat tu-exec.txt" },
      userA, // KHÔNG có requestApproval
    );
    expect(out).toContain("xin-chao");
    const viaTool = await readFileTool.execute({ path: "tu-exec.txt" }, userA);
    expect(viaTool.trim()).toBe("xin-chao");
    // user B không thấy file này
    await expect(readFileTool.execute({ path: "tu-exec.txt" }, userB)).rejects.toThrow();
  });

  it("lệnh ngoài allowlist cần phê duyệt", async () => {
    await expect(
      execTool.execute({ command: "some_unknown_binary --do-something" }, userA),
    ).rejects.toThrow(/chưa được phê duyệt/);
  });

  it("code trong dấu nháy / heredoc không bị hiểu nhầm thành lệnh lạ", () => {
    // python -c: dấu ; nằm trong chuỗi → vẫn chỉ là 1 lệnh "python"
    expect(commandHeads(`python -c "a=1; print(a)"`)).toEqual(["python"]);
    // heredoc: mọi dòng code bên trong bị bỏ qua
    expect(
      commandHeads("python - <<'PY'\nfrom docx import Document\ndoc.save('x.docx')\nPY"),
    ).toEqual(["python"]);
    // pipeline thật vẫn tách đúng
    expect(commandHeads("cat a.txt | grep x && node b.js")).toEqual(["cat", "grep", "node"]);
    // đường dẫn tuyệt đối lấy phần tên lệnh
    expect(commandHeads("/usr/bin/python3 x.py")).toEqual(["python3"]);
  });

  it("lệnh trong $(...) / backtick cũng phải qua allowlist", async () => {
    // lệnh lạ giấu trong command substitution vẫn bị bắt
    expect(commandHeads("echo $(binary_la_hoac --x)")).toContain("binary_la_hoac");
    expect(commandHeads("echo `binary_la_hoac`")).toContain("binary_la_hoac");
    expect(commandHeads('echo "$(binary_la_hoac)"')).toContain("binary_la_hoac");
    expect(commandHeads("cat <(binary_la_hoac)")).toContain("binary_la_hoac");
    // nháy đơn: shell KHÔNG thực thi → không báo nhầm
    expect(commandHeads("echo 'echo $(binary_la_hoac)'")).toEqual(["echo"]);
    // chú thích cũng không chạy
    expect(commandHeads("echo hi # binary_la_hoac")).toEqual(["echo"]);
    // lệnh hợp lệ bên trong vẫn chạy bình thường
    expect(commandHeads("echo $(python -c 'print(1)')")).toEqual(["echo", "python"]);

    await expect(
      execTool.execute({ command: "echo $(binary_la_hoac)" }, userA),
    ).rejects.toThrow(/chưa được phê duyệt/);
  });

  it("chạy được python -c và heredoc không cần phê duyệt", async () => {
    const inline = await execTool.execute(
      { command: `python -c "a=6*7; print('ket-qua', a)" || python3 -c "a=6*7; print('ket-qua', a)"` },
      userA,
    );
    expect(inline).toMatch(/ket-qua 42|not found|recognized/i);

    const heredoc = await execTool.execute(
      { command: "python - <<'PY'\nprint('tu-heredoc')\nPY" },
      userA,
    );
    expect(heredoc).toMatch(/tu-heredoc|not found|recognized/i);
  });

  it("lệnh nguy hiểm bị chặn cứng dù có phê duyệt", async () => {
    const approving: ToolContext = { ...userA, requestApproval: async () => true };
    await expect(execTool.execute({ command: "rm -rf /" }, approving)).rejects.toThrow(/bị chặn/);
    await expect(execTool.execute({ command: "sudo reboot" }, approving)).rejects.toThrow(/bị chặn/);
  });

  it("chạy python được (nếu máy có python)", async () => {
    const out = await execTool.execute(
      { command: "python -c \"print(6*7)\" || python3 -c \"print(6*7)\"" },
      userA,
    );
    expect(out).toMatch(/42|not found|không|recognized/i);
  });
});

describe("chống thoát jail bằng symlink (confineMediaPath / realpath)", () => {
  it("confineMediaPath từ chối file ngoài vùng dữ liệu", async () => {
    const outside = join(root, "ngoai-vung.txt");
    await writeFile(outside, "du lieu he thong", "utf8");
    const roots = [resolve(root, "users", "telegram-111"), resolve(root, "shared")];

    expect(await confineMediaPath(outside, roots)).toBeNull();
    expect(await confineMediaPath("C:\\Windows\\win.ini", roots)).toBeNull();
    expect(await confineMediaPath("/etc/passwd", roots)).toBeNull();
    // file hợp lệ trong thư mục riêng thì cho qua
    const ok = join(roots[0]!, "bao-cao.txt");
    expect(await confineMediaPath(ok, roots)).toBe(resolve(ok));
    // file trong vùng dùng chung cũng hợp lệ
    expect(await confineMediaPath(join(roots[1]!, "AGENT.md"), roots)).not.toBeNull();
  });

  it("symlink trỏ ra ngoài bị chặn khi đọc (nếu OS cho tạo symlink)", async () => {
    const outside = join(root, "bi-mat-ngoai.txt");
    await writeFile(outside, "khong duoc doc", "utf8");
    const linkPath = join(root, "users", "telegram-111", "link-ra-ngoai.txt");
    try {
      await symlink(outside, linkPath);
    } catch {
      return; // Windows không có quyền tạo symlink → bỏ qua ca này
    }
    await expect(readFileTool.execute({ path: "link-ra-ngoai.txt" }, userA)).rejects.toThrow(
      /symlink|ngoài/i,
    );
    const roots = [resolve(root, "users", "telegram-111")];
    expect(await confineMediaPath(linkPath, roots)).toBeNull();
  });
});

describe("file ghi nhớ", () => {
  it("USER.md của mỗi người dùng là riêng biệt", async () => {
    await writeFileTool.execute({ path: "USER.md", content: "Ten: An", append: false }, userA);
    await writeFileTool.execute({ path: "USER.md", content: "Ten: Binh", append: false }, userB);
    expect(await readFileTool.execute({ path: "USER.md" }, userA)).toBe("Ten: An");
    expect(await readFileTool.execute({ path: "USER.md" }, userB)).toBe("Ten: Binh");
    // đọc trực tiếp trên đĩa để chắc chắn 2 file khác nhau
    const a = await readFile(join(root, "users", "telegram-111", "USER.md"), "utf8");
    const b = await readFile(join(root, "users", "telegram-222", "USER.md"), "utf8");
    expect(a).not.toBe(b);
  });

  it("thiếu workDir thì dùng gốc workspace (chat HTTP/cron)", async () => {
    const legacy: ToolContext = { ctx, workspaceDataDir: root };
    await mkdir(root, { recursive: true });
    const res = await writeFileTool.execute(
      { path: "goc.txt", content: "http-chat", append: false },
      legacy,
    );
    expect(res).toContain("goc.txt");
    expect(await readFileTool.execute({ path: "goc.txt" }, legacy)).toBe("http-chat");
  });
});
