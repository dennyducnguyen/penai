import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAuth, refreshAuth, saveAuth, type CodexAuth, DEFAULT_AUTH_FILE } from "./oauth.js";

export const DEFAULT_ACCOUNTS_DIR = ".local/codex-accounts";

/**
 * Pool nhiều tài khoản ChatGPT subscription, 3 nguyên tắc:
 * 1. Chọn tài khoản ÍT VIỆC ĐANG CHẠY nhất (in-flight) thay vì round-robin mù
 *    — nhiều người chat cùng lúc được dàn đều thật sự, kể cả khi lượt chạy dài
 *    ngắn khác nhau. Hòa nhau thì xoay vòng theo counter.
 * 2. Tài khoản dính 429/5xx bị COOLDOWN (tôn trọng Retry-After, mặc định lũy
 *    tiến 60s→30ph) và request hiện tại failover NGAY sang tài khoản khác —
 *    không retry nhiều lần trên tài khoản đã nghẽn.
 * 3. Token lỗi refresh (reauth) chỉ loại đúng tài khoản đó, các tài khoản
 *    khác vẫn phục vụ.
 *
 * Lưu trữ: mỗi tài khoản 1 file JSON trong accountsDir; file legacy
 * .local/codex-auth.json (nếu có) luôn là tài khoản "chinh".
 */

export interface CodexAccountState {
  alias: string;
  file: string;
  auth: CodexAuth;
  /** Số request đang chạy trên tài khoản này. */
  inFlight: number;
  /** Bị nghẽn (429/5xx) tới thời điểm này (epoch ms). 0 = sẵn sàng. */
  cooldownUntil: number;
  /** Số lần dính cooldown liên tiếp — quyết định thời gian nghỉ lũy tiến. */
  cooldownStreak: number;
  /** Refresh token hỏng — cần đăng nhập lại, loại khỏi vòng xoay. */
  needsReauth: boolean;
  /** Promise refresh đang chạy — dedupe refresh song song. */
  refreshing: Promise<CodexAuth> | null;
}

export interface CodexAccountPublic {
  alias: string;
  email?: string;
  accountId: string;
  status: "ready" | "cooldown" | "needs_reauth";
  /** Giây còn lại của cooldown (nếu status=cooldown). */
  cooldownSeconds?: number;
  inFlight: number;
}

const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 30 * 60_000;

function aliasFromAuth(auth: CodexAuth): string {
  const base = (auth.email ?? auth.accountId).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return base.replace(/^-+|-+$/g, "").slice(0, 60) || "account";
}

export class CodexAccountManager {
  private accounts = new Map<string, CodexAccountState>();
  private rrCounter = 0;
  private loaded = false;

  constructor(
    private legacyAuthFile: string = DEFAULT_AUTH_FILE,
    private accountsDir: string = DEFAULT_ACCOUNTS_DIR,
  ) {}

  /** Nạp tài khoản từ đĩa (legacy file + accountsDir). Idempotent. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const legacy = loadAuth(this.legacyAuthFile);
    if (legacy) this.put("chinh", this.legacyAuthFile, legacy);
    if (existsSync(this.accountsDir)) {
      for (const f of readdirSync(this.accountsDir)) {
        if (!f.endsWith(".json")) continue;
        const file = join(this.accountsDir, f);
        try {
          const auth = JSON.parse(readFileSync(file, "utf8")) as CodexAuth;
          const alias = f.slice(0, -5);
          // trùng accountId với tài khoản đã nạp → bỏ (đăng nhập lặp)
          if ([...this.accounts.values()].some((a) => a.auth.accountId === auth.accountId)) {
            continue;
          }
          this.put(alias, file, auth);
        } catch {
          // file hỏng — bỏ qua
        }
      }
    }
  }

  private put(alias: string, file: string, auth: CodexAuth): void {
    this.accounts.set(alias, {
      alias,
      file,
      auth,
      inFlight: 0,
      cooldownUntil: 0,
      cooldownStreak: 0,
      needsReauth: false,
      refreshing: null,
    });
  }

  /** Thêm tài khoản mới sau khi OAuth xong (alias tự sinh từ email). */
  addAccount(auth: CodexAuth): CodexAccountPublic {
    this.load();
    // Đăng nhập lại tài khoản đã có → cập nhật tại chỗ (kể cả legacy "chinh")
    for (const st of this.accounts.values()) {
      if (st.auth.accountId === auth.accountId) {
        st.auth = auth;
        st.needsReauth = false;
        st.cooldownUntil = 0;
        st.cooldownStreak = 0;
        saveAuth(auth, st.file);
        return this.toPublic(st);
      }
    }
    let alias = aliasFromAuth(auth);
    while (this.accounts.has(alias)) alias += "-2";
    mkdirSync(this.accountsDir, { recursive: true });
    const file = join(this.accountsDir, `${alias}.json`);
    writeFileSync(file, JSON.stringify(auth, null, 2), "utf8");
    this.put(alias, file, auth);
    const st = this.accounts.get(alias)!;
    return this.toPublic(st);
  }

  removeAccount(alias: string): boolean {
    this.load();
    const st = this.accounts.get(alias);
    if (!st) return false;
    this.accounts.delete(alias);
    try {
      rmSync(st.file);
    } catch {
      // file đã mất — vẫn coi là xóa xong
    }
    return true;
  }

  size(): number {
    this.load();
    return this.accounts.size;
  }

  list(): CodexAccountPublic[] {
    this.load();
    return [...this.accounts.values()].map((s) => this.toPublic(s));
  }

  private toPublic(s: CodexAccountState): CodexAccountPublic {
    const now = Date.now();
    const cooling = s.cooldownUntil > now;
    return {
      alias: s.alias,
      ...(s.auth.email ? { email: s.auth.email } : {}),
      accountId: s.auth.accountId,
      status: s.needsReauth ? "needs_reauth" : cooling ? "cooldown" : "ready",
      ...(cooling ? { cooldownSeconds: Math.ceil((s.cooldownUntil - now) / 1000) } : {}),
      inFlight: s.inFlight,
    };
  }

  /**
   * Thứ tự tài khoản để thử cho 1 request: sẵn sàng trước (ít in-flight nhất,
   * hòa thì xoay vòng), rồi tới tài khoản đang cooldown (phòng khi mọi tài
   * khoản đều nghẽn — vẫn thử thay vì bó tay), bỏ hẳn needs_reauth.
   */
  pickOrder(): CodexAccountState[] {
    this.load();
    const now = Date.now();
    const usable = [...this.accounts.values()].filter((s) => !s.needsReauth);
    const ready = usable.filter((s) => s.cooldownUntil <= now);
    const cooling = usable
      .filter((s) => s.cooldownUntil > now)
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    // ít việc nhất trước; hòa thì round-robin (counter dịch điểm bắt đầu)
    const start = this.rrCounter++ % Math.max(1, ready.length);
    const rotated = [...ready.slice(start), ...ready.slice(0, start)];
    rotated.sort((a, b) => a.inFlight - b.inFlight); // sort ổn định giữ thứ tự xoay
    return [...rotated, ...cooling];
  }

  /**
   * Đánh dấu tài khoản nghẽn (429/5xx). Có Retry-After thì tin server (kể cả
   * khi ngắn hơn backoff); không có thì backoff lũy tiến 60s→30ph.
   */
  markThrottled(alias: string, retryAfterMs?: number): void {
    const s = this.accounts.get(alias);
    if (!s) return;
    s.cooldownStreak += 1;
    const backoff = Math.min(
      COOLDOWN_BASE_MS * 2 ** (s.cooldownStreak - 1),
      COOLDOWN_MAX_MS,
    );
    const waitMs =
      retryAfterMs !== undefined && retryAfterMs > 0
        ? Math.max(retryAfterMs, 1000)
        : backoff;
    s.cooldownUntil = Date.now() + waitMs;
  }

  /** Request thành công → xóa vết nghẽn. */
  markOk(alias: string): void {
    const s = this.accounts.get(alias);
    if (!s) return;
    s.cooldownStreak = 0;
    s.cooldownUntil = 0;
  }

  markNeedsReauth(alias: string): void {
    const s = this.accounts.get(alias);
    if (s) s.needsReauth = true;
  }

  acquire(alias: string): void {
    const s = this.accounts.get(alias);
    if (s) s.inFlight += 1;
  }

  release(alias: string): void {
    const s = this.accounts.get(alias);
    if (s) s.inFlight = Math.max(0, s.inFlight - 1);
  }

  /**
   * Token còn hạn của 1 tài khoản (tự refresh khi sắp hết, dedupe song song).
   * Refresh hỏng → needsReauth + throw.
   */
  async freshAuth(alias: string, forceRefresh = false): Promise<CodexAuth> {
    const s = this.accounts.get(alias);
    if (!s) throw new Error(`Tài khoản ChatGPT "${alias}" không tồn tại`);
    if (!forceRefresh && s.auth.expiresAt - 60_000 > Date.now()) return s.auth;
    if (!s.refreshing) {
      s.refreshing = refreshAuth(s.auth)
        .then((next) => {
          s.auth = next;
          s.needsReauth = false;
          saveAuth(next, s.file);
          return next;
        })
        .catch((err: Error) => {
          // refresh token hỏng thật (invalid_grant) → cần đăng nhập lại;
          // lỗi mạng thoáng qua thì không khóa tài khoản
          if (/invalid_grant|expired|revoked/i.test(err.message)) {
            s.needsReauth = true;
          }
          throw err;
        })
        .finally(() => {
          s.refreshing = null;
        });
    }
    return s.refreshing;
  }
}
