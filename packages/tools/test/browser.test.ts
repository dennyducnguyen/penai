import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  cookieInDomains,
  cookieMeta,
  CookieParseError,
  createDefaultToolRegistry,
  dropExpired,
  isPrivateAddress,
  isUrlAllowed,
  loadCookieJson,
  mergeCookies,
  mergeSessionCookies,
  parseCookieInput,
  type BrowserAction,
  type BrowserCookie,
} from "../src/index.js";
import { formatSnapshot, looksLikeChallenge, type PageSnapshot } from "../src/browser/page-script.js";

const future = Math.floor(Date.now() / 1000) + 30 * 86400;
const past = Math.floor(Date.now() / 1000) - 86400;

// Dạng Cookie-Editor → Export → JSON (giá trị giả)
const COOKIE_EDITOR = JSON.stringify([
  { domain: ".shopee.vn", expirationDate: future, hostOnly: false, httpOnly: true, name: "SPC_EC", path: "/", sameSite: "no_restriction", secure: true, session: false, storeId: "0", value: "abc" },
  { domain: "shopee.vn", expirationDate: future, hostOnly: true, httpOnly: false, name: "SPC_SI", path: "/", sameSite: "lax", secure: true, session: false, value: "def" },
  { domain: ".shopee.vn", hostOnly: false, httpOnly: false, name: "_hj", path: "/", sameSite: "unspecified", secure: false, session: true, value: "x" },
  { domain: ".shopee.vn", expirationDate: future, name: "BAD NAME", path: "/", value: "1" },
]);

describe("parseCookieInput", () => {
  it("đọc JSON Cookie-Editor: tên miền, host-only, sameSite, cookie phiên; bỏ cookie hỏng", () => {
    const c = parseCookieInput(COOKIE_EDITOR);
    expect(c.map((x) => x.name)).toEqual(["SPC_EC", "SPC_SI", "_hj"]);
    expect(c[0]).toMatchObject({ domain: ".shopee.vn", sameSite: "None", secure: true, httpOnly: true, expires: future });
    expect(c[1]).toMatchObject({ domain: "shopee.vn", sameSite: "Lax" });
    expect(c[2]).toMatchObject({ expires: -1, sameSite: "Lax" });
  });

  it("SameSite=None thiếu Secure bị hạ về Lax (Chromium từ chối kiểu này)", () => {
    const c = parseCookieInput(JSON.stringify([{ domain: ".a.vn", name: "k", value: "v", sameSite: "no_restriction", secure: false }]));
    expect(c[0]!.sameSite).toBe("Lax");
  });

  it("nhận storageState của Playwright ({cookies: [...]})", () => {
    const c = parseCookieInput(JSON.stringify({ cookies: [{ name: "a", value: "1", domain: ".x.vn", path: "/", expires: future }], origins: [] }));
    expect(c).toHaveLength(1);
    expect(c[0]!.expires).toBe(future);
  });

  it("đọc cookies.txt kiểu Netscape (kể cả dòng #HttpOnly_)", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      `.shopee.vn\tTRUE\t/\tTRUE\t${future}\tSPC_U\t12345`,
      `#HttpOnly_shopee.vn\tFALSE\t/\tTRUE\t0\tSPC_ST\ttok\tco-tab`,
    ].join("\n");
    const c = parseCookieInput(txt);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ name: "SPC_U", domain: ".shopee.vn", secure: true, expires: future });
    expect(c[1]).toMatchObject({ name: "SPC_ST", domain: "shopee.vn", httpOnly: true, expires: -1, value: "tok\tco-tab" });
  });

  it("chuỗi header 'a=b; c=d' cần tên miền", () => {
    expect(() => parseCookieInput("a=1; b=2")).toThrow(CookieParseError);
    const c = parseCookieInput("Cookie: a=1; b=x=y", { defaultDomain: "https://shopee.vn/abc" });
    expect(c.map((x) => [x.name, x.value, x.domain])).toEqual([
      ["a", "1", ".shopee.vn"],
      ["b", "x=y", ".shopee.vn"],
    ]);
  });

  it("nội dung rỗng / JSON hỏng / không có cookie → lỗi tiếng Việt dễ hiểu", () => {
    expect(() => parseCookieInput("   ")).toThrow(/trống/);
    expect(() => parseCookieInput("[{bad json")).toThrow(/JSON/);
    expect(() => parseCookieInput("[]")).toThrow(/Không tìm thấy cookie/);
  });
});

describe("gộp / lọc cookie", () => {
  const ck = (name: string, domain: string, value = "v", expires = future): BrowserCookie => ({
    name, value, domain, path: "/", expires, httpOnly: false, secure: true, sameSite: "Lax",
  });

  it("mergeCookies: cookie mới thay cookie cùng tên + tên miền + đường dẫn", () => {
    const m = mergeCookies([ck("a", ".x.vn", "1"), ck("b", ".x.vn")], [ck("a", ".x.vn", "2"), ck("a", "x.vn", "3")]);
    expect(m.filter((c) => c.name === "a").map((c) => c.value).sort()).toEqual(["2", "3"]);
    expect(m).toHaveLength(3);
  });

  it("dropExpired giữ cookie phiên, bỏ cookie hết hạn", () => {
    expect(dropExpired([ck("a", ".x.vn", "v", past), ck("b", ".x.vn", "v", -1), ck("c", ".x.vn")]).map((c) => c.name)).toEqual(["b", "c"]);
  });

  it("mergeSessionCookies chỉ nhận cookie thuộc tên miền hồ sơ đã có (không gom cookie quảng cáo)", () => {
    const profile = [ck("SPC_EC", ".shopee.vn", "old")];
    const session = [ck("SPC_EC", ".shopee.vn", "new"), ck("x", "cf.shopee.vn"), ck("ads", ".doubleclick.net")];
    const out = mergeSessionCookies(profile, session);
    expect(out.map((c) => `${c.name}@${c.domain}=${c.value}`).sort()).toEqual(["SPC_EC@.shopee.vn=new", "x@cf.shopee.vn=v"]);
    expect(cookieInDomains({ domain: "evilshopee.vn" }, ["shopee.vn"])).toBe(false);
  });

  it("cookieMeta không chứa giá trị; loadCookieJson bỏ phần tử hỏng", () => {
    const meta = cookieMeta([ck("a", ".x.vn", "bi-mat")]);
    expect(JSON.stringify(meta)).not.toContain("bi-mat");
    expect(meta[0]!.valueLength).toBe(6);
    expect(loadCookieJson(JSON.stringify([ck("a", ".x.vn"), { name: "", domain: "x" }]))).toHaveLength(1);
    expect(loadCookieJson("không phải json")).toEqual([]);
  });
});

describe("chặn mạng nội bộ (SSRF)", () => {
  it("isPrivateAddress", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "160.30.161.46", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("isUrlAllowed chặn localhost, IP riêng, giao thức lạ; cho data:/about:", async () => {
    expect(await isUrlAllowed("http://127.0.0.1:18800/healthz", false)).toBe(false);
    expect(await isUrlAllowed("http://localhost/", false)).toBe(false);
    expect(await isUrlAllowed("http://[::1]/", false)).toBe(false);
    expect(await isUrlAllowed("http://192.168.1.1/admin", false)).toBe(false);
    expect(await isUrlAllowed("http://intranet/", false)).toBe(false);
    expect(await isUrlAllowed("file:///etc/passwd", false)).toBe(false);
    expect(await isUrlAllowed("ftp://example.com/", false)).toBe(false);
    expect(await isUrlAllowed("data:text/html,hi", false)).toBe(true);
    expect(await isUrlAllowed("about:blank", false)).toBe(true);
    expect(await isUrlAllowed("http://8.8.8.8/", false)).toBe(true);
    expect(await isUrlAllowed("http://127.0.0.1/", true)).toBe(true);
  });
});

describe("mô tả trang cho agent", () => {
  const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
    title: "Trái cây sấy",
    url: "https://tiki.vn/search?q=trai-cay-say",
    scrollY: 0,
    scrollH: 4000,
    vh: 800,
    total: 2,
    items: [
      { ref: "e1", tag: "input", role: "", name: "Tìm kiếm", type: "search", value: "trái cây", href: "", checked: false, disabled: false, inView: true },
      { ref: "e2", tag: "a", role: "", name: "Hỗn hợp trái cây sấy 30.000₫", type: "", value: "", href: "/san-pham-p1.html", checked: false, disabled: false, inView: false },
    ],
    text: "Kết quả\n\n\nHỗn hợp trái cây sấy   30.000₫",
    ...over,
  });

  it("liệt kê phần tử theo ref + cửa sổ chữ + gợi ý đọc tiếp", () => {
    const t = formatSnapshot(snap(), { maxItems: 10, textChars: 10 });
    expect(t).toContain('[e1]★ ô nhập (search) "Tìm kiếm" = "trái cây"');
    expect(t).toContain('[e2] link "Hỗn hợp trái cây sấy 30.000₫" → /san-pham-p1.html');
    expect(t).toContain("Đang xem: 0–800px / cao 4000px (20% trang)");
    expect(t).toMatch(/đọc tiếp: action "text" offset 10/);
    expect(t).not.toContain("CAPTCHA");
  });

  it("nhận ra trang xác minh chống robot → dặn agent dừng, không tự giải", () => {
    const verify = snap({ url: "https://shopee.vn/verify/captcha?anti_bot_tracking_id=x", title: "Shopee" });
    expect(looksLikeChallenge(verify)).toBe(true);
    expect(formatSnapshot(verify, { maxItems: 5, textChars: 100 })).toMatch(/KHÔNG tự giải/);
    expect(looksLikeChallenge(snap({ text: "Please slide to complete the puzzle. Verify to continue" }))).toBe(true);
    expect(looksLikeChallenge(snap())).toBe(false);
  });
});

describe("tool browser", () => {
  const ctx: WorkspaceContext = {
    workspaceId: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-000000000002",
    role: "operator",
  };
  const reg = createDefaultToolRegistry();
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "penai-browser-"));
  });

  it("không có trình duyệt trong ngữ cảnh → báo chưa bật (không lỗi)", async () => {
    const r = await reg.execute("browser", { action: "open", url: "https://tiki.vn" }, { ctx, workspaceDataDir: dir });
    expect(r.isError).toBe(false);
    expect(r.result).toMatch(/chưa bật/);
  });

  it("chuyển tham số thành thao tác; thiếu ref → lỗi rõ ràng", async () => {
    const seen: BrowserAction[] = [];
    const browser = { act: async (a: BrowserAction) => (seen.push(a), { text: `ok ${a.action}` }) };
    await reg.execute("browser", { action: "type", ref: "e3", text: "trái cây sấy", submit: true }, { ctx, workspaceDataDir: dir, browser });
    await reg.execute("browser", { url: "https://tiki.vn", action: "text" }, { ctx, workspaceDataDir: dir, browser });
    expect(seen).toEqual([
      { action: "type", ref: "e3", text: "trái cây sấy", submit: true },
      { action: "open", url: "https://tiki.vn" },
      { action: "text" },
    ]);
    const bad = await reg.execute("browser", { action: "click" }, { ctx, workspaceDataDir: dir, browser });
    expect(bad.isError).toBe(true);
    expect(bad.result).toMatch(/ref/);
  });

  it("screenshot: lưu ảnh vào thư mục làm việc và đưa ảnh cho mô hình xem", async () => {
    const shown: string[] = [];
    const browser = { act: async () => ({ text: "Đã chụp màn hình: Tiki", image: Buffer.from([0xff, 0xd8, 0xff]) }) };
    const r = await reg.execute(
      "browser",
      { action: "screenshot" },
      { ctx, workspaceDataDir: dir, workDir: dir, browser, showImage: (d) => shown.push(d) },
    );
    expect(r.isError).toBe(false);
    expect(r.result).toMatch(/browser\/man-hinh-.*\.jpg/);
    expect(shown[0]).toBe("data:image/jpeg;base64,/9j/");
    expect((await readdir(join(dir, "browser"))).some((f) => f.endsWith(".jpg"))).toBe(true);
  });
});
