import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { BrowserCookie } from "./cookies.js";
import { isUrlAllowed } from "./net-guard.js";
import { formatSnapshot, REF_ATTR, snapshotScript, type PageSnapshot } from "./page-script.js";

/**
 * Trình duyệt cho agent: MỘT tiến trình Chromium chạy ngầm (headless) dùng chung,
 * mỗi cặp agent + người dùng có một phiên riêng (BrowserContext: cookie, tab) để
 * làm nhiều bước liên tiếp — mở trang, xem, cuộn, bấm, điền, chụp màn hình.
 *
 * Giữ RAM trong tầm: tối đa `maxSessions` phiên cùng lúc (phiên cũ nhất đang rảnh bị
 * đóng nhường chỗ), phiên rảnh quá `idleMs` tự đóng, không còn phiên thì tắt hẳn
 * Chromium. Video/âm thanh không tải. Mọi request qua net-guard (chặn mạng nội bộ).
 */

export interface BrowserProfileData {
  id: string;
  /** Đổi khi cookie/cấu hình hồ sơ đổi → phiên đang mở bằng bản cũ được mở lại. */
  version: string;
  cookies: BrowserCookie[];
  userAgent?: string;
  locale?: string;
  timezone?: string;
  autoSave: boolean;
}

/** Ai đang dùng trình duyệt — runtime dựng cho mỗi lượt chạy agent. */
export interface BrowserOwner {
  /** Khóa phiên: cùng khóa = cùng tab, cùng cookie (vd "<workspace>:<agent>:<người dùng>"). */
  key: string;
  /** Nạp hồ sơ agent đang gán (null = trình duyệt trống). Gọi mỗi thao tác — nên nhẹ. */
  loadProfile: () => Promise<BrowserProfileData | null>;
  /** Lưu lại cookie khi đóng phiên (hồ sơ bật auto_save). */
  saveCookies?: (profileId: string, cookies: BrowserCookie[]) => Promise<void>;
}

export type BrowserAction =
  | { action: "open"; url: string }
  | { action: "snapshot" }
  | { action: "text"; offset?: number }
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; submit?: boolean }
  | { action: "select"; ref: string; value: string }
  | { action: "press"; key: string }
  | { action: "scroll"; direction?: "down" | "up"; ref?: string }
  | { action: "back" }
  | { action: "wait"; ms?: number; text?: string }
  | { action: "screenshot"; fullPage?: boolean }
  | { action: "close" };

export interface BrowserActionResult {
  text: string;
  /** Ảnh chụp màn hình JPEG (action screenshot). */
  image?: Buffer;
}

export interface BrowserManagerOptions {
  maxSessions?: number;
  idleMs?: number;
  /** Đường dẫn Chrome/Chromium tự chọn (biến CHROME_PATH). */
  executablePath?: string;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

const VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 10_000;
const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=Translate,MediaRouter",
  "--mute-audio",
];
// Giảm dấu hiệu "trình duyệt tự động" hay bị trang thương mại điện tử soi.
const STEALTH_INIT = `
Object.defineProperty(Navigator.prototype, "webdriver", { get: function () { return undefined; } });
if (!window.chrome) { window.chrome = { runtime: {} }; }
`;

class Session {
  context!: BrowserContext;
  page!: Page;
  lastUsed = Date.now();
  busy = false;
  chain: Promise<unknown> = Promise.resolve();
  notes: string[] = [];
  blocked = new Set<string>();
  constructor(
    readonly key: string,
    readonly profile: BrowserProfileData | null,
    readonly saveCookies?: BrowserOwner["saveCookies"],
  ) {}
}

export class BrowserUnavailableError extends Error {}

/** Lỗi thao tác kèm mô tả trang hiện tại để agent tự xoay xở tiếp. */
export class BrowserActionError extends Error {}

export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private sessions = new Map<string, Session>();
  private idleSince = Date.now();
  private timer: NodeJS.Timeout;
  readonly maxSessions: number;
  readonly idleMs: number;

  constructor(private opts: BrowserManagerOptions = {}) {
    this.maxSessions = Math.max(1, opts.maxSessions ?? 2);
    this.idleMs = Math.max(60_000, opts.idleMs ?? 10 * 60_000);
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref?.();
  }

  /** Chromium đã cài chưa (không khởi động trình duyệt). */
  static async installed(executablePath?: string): Promise<{ ok: boolean; path: string }> {
    if (executablePath) return { ok: existsSync(executablePath), path: executablePath };
    try {
      const { chromium } = await import("playwright-core");
      const p = chromium.executablePath();
      return { ok: !!p && existsSync(p), path: p };
    } catch {
      return { ok: false, path: "" };
    }
  }

  stats(): { running: boolean; sessions: Array<{ key: string; profileId: string | null; url: string; idleSec: number }> } {
    return {
      running: !!this.browser,
      sessions: [...this.sessions.values()].map((s) => ({
        key: s.key,
        profileId: s.profile?.id ?? null,
        url: s.page && !s.page.isClosed() ? s.page.url() : "",
        idleSec: Math.round((Date.now() - s.lastUsed) / 1000),
      })),
    };
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      let chromium: typeof import("playwright-core").chromium;
      try {
        chromium = (await import("playwright-core")).chromium;
      } catch {
        throw new BrowserUnavailableError("Thiếu thư viện playwright-core");
      }
      // Bỏ cờ --enable-automation mặc định của Playwright (thanh "đang bị điều khiển tự động")
      const base = { headless: true, args: LAUNCH_ARGS, ignoreDefaultArgs: ["--enable-automation"], timeout: 60_000 };
      const tries: Array<Parameters<typeof chromium.launch>[0]> = this.opts.executablePath
        ? [{ ...base, executablePath: this.opts.executablePath }]
        : // "chromium" = Chromium đầy đủ ở chế độ headless mới (giống trình duyệt thật hơn bản headless shell)
          [{ ...base, channel: "chromium" }, base];
      let lastErr: unknown;
      for (const o of tries) {
        try {
          const b = await chromium.launch(o);
          b.on("disconnected", () => {
            if (this.browser === b) this.browser = null;
            this.sessions.clear();
          });
          this.opts.logger?.info(`Trình duyệt: đã mở Chromium ${b.version()}`);
          return b;
        } catch (e) {
          lastErr = e;
        }
      }
      const msg = (lastErr as Error)?.message ?? "";
      throw new BrowserUnavailableError(
        /Executable doesn't exist|not found|ENOENT/i.test(msg)
          ? "Máy chủ chưa cài trình duyệt Chromium. Quản trị viên chạy: sudo penai install-browser (hoặc chờ vài phút nếu vừa cập nhật — hệ thống đang tự cài)."
          : `Không mở được Chromium: ${msg.split("\n")[0]}`,
      );
    })();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  private defaultUserAgent(b: Browser): string {
    const major = b.version().split(".")[0] || "140";
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  private async openSession(owner: BrowserOwner, profile: BrowserProfileData | null): Promise<Session> {
    // Đủ phiên → đóng phiên rảnh lâu nhất (lưu cookie của nó) để nhường chỗ
    if (this.sessions.size >= this.maxSessions) {
      const idle = [...this.sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) {
        throw new BrowserActionError(
          `Trình duyệt đang bận: đã mở tối đa ${this.maxSessions} phiên cùng lúc. Thử lại sau ít phút.`,
        );
      }
      await this.closeSession(idle.key, true);
    }
    const b = await this.getBrowser();
    const s = new Session(owner.key, profile, owner.saveCookies);
    s.context = await b.newContext({
      viewport: VIEWPORT,
      userAgent: profile?.userAgent || this.defaultUserAgent(b),
      locale: profile?.locale || "vi-VN",
      timezoneId: profile?.timezone || "Asia/Ho_Chi_Minh",
      acceptDownloads: false,
      extraHTTPHeaders: { "Accept-Language": `${profile?.locale || "vi-VN"},vi;q=0.9,en-US;q=0.8,en;q=0.7` },
    });
    s.context.setDefaultTimeout(ACTION_TIMEOUT);
    s.context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await s.context.addInitScript(STEALTH_INIT);
    await s.context.route("**/*", async (route) => {
      const req = route.request();
      if (req.resourceType() === "media") return route.abort();
      if (!(await isUrlAllowed(req.url()))) {
        try {
          s.blocked.add(new URL(req.url()).host);
        } catch {
          /* bỏ qua */
        }
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    if (profile?.cookies.length) {
      // Thêm từng cookie: một cookie hỏng không làm hỏng cả bộ
      const bad: string[] = [];
      try {
        await s.context.addCookies(profile.cookies);
      } catch {
        for (const c of profile.cookies) {
          try {
            await s.context.addCookies([c]);
          } catch {
            bad.push(c.name);
          }
        }
      }
      if (bad.length) s.notes.push(`Bỏ qua ${bad.length} cookie không hợp lệ: ${bad.slice(0, 5).join(", ")}`);
    }
    s.page = await s.context.newPage();
    this.watchPage(s, s.page);
    // Đăng ký SAU tab đầu tiên: link target=_blank / window.open → chuyển sang tab mới
    s.context.on("page", (p) => {
      s.page = p;
      this.watchPage(s, p);
      s.notes.push("Trang vừa mở thêm một tab mới — đã chuyển sang tab đó.");
    });
    this.sessions.set(owner.key, s);
    return s;
  }

  private watchPage(s: Session, p: Page): void {
    p.on("dialog", (d) => {
      s.notes.push(`Trang hiện hộp thoại (${d.type()}): "${d.message().slice(0, 200)}" — đã tự đóng.`);
      void d.dismiss().catch(() => {});
    });
    p.on("close", () => {
      if (s.page === p) {
        const others = s.context.pages().filter((x) => !x.isClosed());
        if (others.length) s.page = others[others.length - 1]!;
      }
    });
  }

  /** Đóng một phiên; save=true → lưu lại cookie vào hồ sơ (nếu hồ sơ bật tự lưu). */
  async closeSession(key: string, save: boolean): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    if (save && s.profile?.autoSave && s.saveCookies) {
      try {
        const cookies = (await s.context.cookies()).map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }));
        await s.saveCookies(s.profile.id, cookies);
      } catch (e) {
        this.opts.logger?.warn(`Trình duyệt: lưu cookie hồ sơ lỗi: ${(e as Error).message}`);
      }
    }
    await s.context.close().catch(() => {});
    if (!this.sessions.size) this.idleSince = Date.now();
  }

  /** Cookie hồ sơ vừa bị quản trị viên sửa → đóng các phiên đang dùng bản cũ (không lưu đè). */
  async closeProfileSessions(profileId: string): Promise<number> {
    const keys = [...this.sessions.values()].filter((s) => s.profile?.id === profileId).map((s) => s.key);
    for (const k of keys) await this.closeSession(k, false);
    return keys.length;
  }

  async closeAll(save = true): Promise<void> {
    for (const k of [...this.sessions.keys()]) await this.closeSession(k, save);
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => {});
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.closeAll(true);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (!s.busy && now - s.lastUsed > this.idleMs) await this.closeSession(s.key, true);
    }
    // Không còn phiên 2 phút → tắt Chromium trả RAM cho máy
    if (!this.sessions.size && this.browser && now - this.idleSince > 120_000) {
      const b = this.browser;
      this.browser = null;
      await b.close().catch(() => {});
      this.opts.logger?.info("Trình duyệt: đã tắt Chromium (không còn phiên nào)");
    }
  }

  /** Thực hiện một thao tác — các thao tác cùng phiên chạy lần lượt. */
  async act(owner: BrowserOwner, a: BrowserAction): Promise<BrowserActionResult> {
    if (a.action === "close") {
      const had = this.sessions.has(owner.key);
      await this.closeSession(owner.key, true);
      return { text: had ? "Đã đóng trình duyệt (cookie đăng nhập đã được lưu lại nếu hồ sơ bật tự lưu)." : "Không có trình duyệt nào đang mở." };
    }
    const profile = await owner.loadProfile();
    let s = this.sessions.get(owner.key);
    const want = profile ? `${profile.id}@${profile.version}` : "";
    const have = s?.profile ? `${s.profile.id}@${s.profile.version}` : "";
    if (s && want !== have && !s.busy) {
      await this.closeSession(owner.key, false);
      s = undefined;
    }
    if (!s || s.page.isClosed()) {
      if (s) await this.closeSession(owner.key, false);
      s = await this.openSession(owner, profile);
    }
    const sess = s;
    const run = sess.chain.then(async () => {
      sess.busy = true;
      try {
        return await this.perform(sess, a);
      } finally {
        sess.busy = false;
        sess.lastUsed = Date.now();
      }
    });
    sess.chain = run.catch(() => {});
    return run;
  }

  private async snapshot(s: Session, maxItems: number): Promise<PageSnapshot> {
    return (await s.page.evaluate(snapshotScript(maxItems))) as PageSnapshot;
  }

  private async describe(s: Session, opts: { maxItems: number; textChars: number; textOffset?: number }): Promise<string> {
    const notes = s.notes.splice(0);
    if (s.blocked.size) {
      notes.push(`Đã chặn truy cập mạng nội bộ: ${[...s.blocked].slice(0, 5).join(", ")}`);
      s.blocked.clear();
    }
    try {
      const snap = await this.snapshot(s, opts.maxItems);
      return formatSnapshot(snap, { ...opts, notes });
    } catch (e) {
      return [...notes.map((n) => `⚠️ ${n}`), `URL: ${s.page.url()}`, `(Chưa đọc được nội dung trang: ${(e as Error).message.split("\n")[0]})`].join("\n");
    }
  }

  /**
   * Chờ trang ổn định sau thao tác: DOM tải xong, rồi chờ tới khi nội dung ngừng
   * thay đổi `quiet` ms (trang SPA như Shopee/Tiki đổi nội dung bằng JavaScript,
   * không phát sự kiện tải trang) — tối đa `max` ms vì trang có banner chạy liên tục.
   */
  private async settle(p: Page, max = 6000, quiet = 700): Promise<void> {
    await p.waitForTimeout(300).catch(() => {});
    await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await p
      .evaluate(
        `new Promise(function (res) {
          var start = Date.now(), t = null, obs = null;
          function done() { if (obs) obs.disconnect(); clearTimeout(t); res(true); }
          function arm() { clearTimeout(t); t = setTimeout(done, ${quiet}); }
          obs = new MutationObserver(function () { if (Date.now() - start > ${max}) done(); else arm(); });
          obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
          arm(); setTimeout(done, ${max});
        })`,
      )
      .catch(() => {});
    // Điều hướng xảy ra trong lúc chờ → đợi trang mới dựng xong
    await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  }

  private locate(s: Session, ref: string) {
    const r = ref.trim().replace(/^\[|\]$/g, "");
    if (!/^e\d{1,4}$/.test(r)) throw new BrowserActionError(`ref "${ref}" không hợp lệ — dùng dạng e12 lấy từ kết quả snapshot.`);
    return s.page.locator(`[${REF_ATTR}="${r}"]`).first();
  }

  private async perform(s: Session, a: Exclude<BrowserAction, { action: "close" }>): Promise<BrowserActionResult> {
    const p = s.page;
    const brief = { maxItems: 60, textChars: 2500 };
    try {
      switch (a.action) {
        case "open": {
          if (!/^https?:\/\//i.test(a.url)) throw new BrowserActionError("Chỉ mở được địa chỉ http:// hoặc https://");
          if (!(await isUrlAllowed(a.url))) {
            throw new BrowserActionError("Địa chỉ này thuộc mạng nội bộ/không phân giải được — không được phép mở.");
          }
          const resp = await p.goto(a.url, { waitUntil: "domcontentloaded" });
          await this.settle(p, 8000);
          const st = resp?.status();
          if (st && st >= 400) s.notes.push(`Máy chủ trang trả mã lỗi HTTP ${st}.`);
          return { text: await this.describe(s, { maxItems: 80, textChars: 3000 }) };
        }
        case "snapshot":
          return { text: await this.describe(s, { maxItems: 150, textChars: 5000 }) };
        case "text": {
          const snap = await this.snapshot(s, 10);
          return {
            text: formatSnapshot({ ...snap, items: [] }, { maxItems: 0, textChars: 12_000, textOffset: a.offset ?? 0 }),
          };
        }
        case "click": {
          const loc = this.locate(s, a.ref);
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: ACTION_TIMEOUT });
          await this.settle(s.page);
          return { text: await this.describe(s, brief) };
        }
        case "type": {
          const loc = this.locate(s, a.ref);
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          const ce = await loc.getAttribute("contenteditable").catch(() => null);
          const editable = ce !== null && ce !== "false";
          if (editable) {
            await loc.click();
            await s.page.keyboard.type(a.text, { delay: 20 });
          } else {
            await loc.fill(a.text);
          }
          if (a.submit) {
            await loc.press("Enter");
            await this.settle(s.page);
          } else {
            await s.page.waitForTimeout(500);
          }
          return { text: await this.describe(s, brief) };
        }
        case "select": {
          const loc = this.locate(s, a.ref);
          try {
            await loc.selectOption({ label: a.value });
          } catch {
            await loc.selectOption(a.value);
          }
          await this.settle(s.page, 4000);
          return { text: await this.describe(s, brief) };
        }
        case "press": {
          await p.keyboard.press(a.key);
          await this.settle(s.page, 4000);
          return { text: await this.describe(s, brief) };
        }
        case "scroll": {
          if (a.ref) {
            await this.locate(s, a.ref).scrollIntoViewIfNeeded();
          } else {
            const dy = a.direction === "up" ? -0.85 : 0.85;
            await p.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * ${dy}))`);
          }
          await p.waitForTimeout(900);
          return { text: await this.describe(s, brief) };
        }
        case "back": {
          await p.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
          await this.settle(p);
          return { text: await this.describe(s, brief) };
        }
        case "wait": {
          if (a.text) {
            await p.getByText(a.text, { exact: false }).first().waitFor({ timeout: Math.min(a.ms ?? 10_000, 20_000) });
          } else {
            await p.waitForTimeout(Math.max(200, Math.min(a.ms ?? 2000, 15_000)));
          }
          return { text: await this.describe(s, brief) };
        }
        case "screenshot": {
          const image = await p.screenshot({ type: "jpeg", quality: 70, fullPage: a.fullPage === true, timeout: 20_000 });
          const title = await p.title().catch(() => "");
          return { text: `Đã chụp màn hình: ${title || "(không tiêu đề)"}\nURL: ${p.url()}`, image };
        }
      }
    } catch (e) {
      if (e instanceof BrowserUnavailableError) throw e;
      const msg = (e as Error).message.split("\n")[0] ?? "lỗi không rõ";
      const hint = /Timeout/i.test(msg)
        ? "Quá thời gian chờ (trang chậm hoặc phần tử bị che/không bấm được)."
        : msg;
      let page = "";
      try {
        page = await this.describe(s, brief);
      } catch {
        /* trang đã đóng */
      }
      throw new BrowserActionError(`${hint}${page ? `\n\nTrang hiện tại:\n${page}` : ""}`);
    }
  }
}
