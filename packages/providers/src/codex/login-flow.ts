import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  saveAuth,
  DEFAULT_AUTH_FILE,
  type CodexAuth,
} from "./oauth.js";

export interface LoginFlow {
  /** URL để người dùng mở và đăng nhập ChatGPT. */
  url: string;
  /** state của phiên — để đối chiếu khi dán link callback. */
  state: string;
  /** Promise hoàn tất khi đăng nhập xong (hoặc reject nếu lỗi/timeout). */
  done: Promise<CodexAuth>;
  /**
   * Hoàn tất bằng tay: nhận URL callback đầy đủ (hoặc chỉ authorization code).
   * Dùng khi PenAI chạy trên server — trình duyệt người dùng redirect về
   * `localhost:1455` trên MÁY HỌ nên server callback không bao giờ nhận được.
   */
  submit(rawUrlOrCode: string): Promise<CodexAuth>;
  /** Hủy phiên: đóng server callback (nhả cổng 1455) và cho `done` reject. */
  cancel(): void;
}

/** Tách code + state từ URL callback dán vào, hoặc coi cả chuỗi là code. */
export function parseCodexCallback(raw: string): { code: string; state?: string } {
  const text = raw.trim();
  if (!text) throw new Error("Chưa nhập gì");
  if (text.includes("://") || text.includes("?")) {
    let u: URL;
    try {
      u = new URL(text.startsWith("http") ? text : `http://localhost:1455${text}`);
    } catch {
      throw new Error("Link callback không hợp lệ");
    }
    const err = u.searchParams.get("error");
    if (err) throw new Error(`OAuth báo lỗi: ${err}`);
    const code = u.searchParams.get("code");
    if (!code) throw new Error("Link không có tham số code");
    const state = u.searchParams.get("state");
    return state ? { code, state } : { code };
  }
  return { code: text };
}

/**
 * Khởi động luồng OAuth PKCE: mở server callback tạm ở 127.0.0.1:1455,
 * trả về URL authorize ngay lập tức + promise hoàn tất.
 * @param openBrowser tự mở trình duyệt (mặc định true)
 */
export function startLoginFlow(opts: {
  authFile?: string;
  openBrowser?: boolean;
  timeoutMs?: number;
  /** false = KHÔNG tự ghi authFile — caller tự quyết định lưu đâu (pool). */
  save?: boolean;
  /**
   * true = cổng callback 1455 chỉ là "nếu được": đang có phiên khác giữ cổng
   * (nhiều người đăng nhập cùng lúc trên server) thì bỏ qua, phiên vẫn hoàn tất
   * bằng cách dán link callback (submit). Mặc định false = lỗi cổng làm hỏng phiên.
   */
  optionalListen?: boolean;
} = {}): LoginFlow {
  const authFile = opts.authFile ?? DEFAULT_AUTH_FILE;
  const openBrowser = opts.openBrowser ?? true;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const save = opts.save ?? true;

  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("base64url");
  const url = buildAuthorizeUrl(challenge, state);

  let settle: { resolve: (a: CodexAuth) => void; reject: (e: Error) => void };
  let closeServer: () => void = () => {};

  /** Đổi code lấy token (dùng chung cho callback tự động và link dán tay). */
  async function finish(code: string): Promise<CodexAuth> {
    const auth = await exchangeCode(code, verifier);
    if (save) saveAuth(auth, authFile);
    closeServer();
    settle.resolve(auth);
    return auth;
  }

  const done = new Promise<CodexAuth>((resolve, reject) => {
    settle = { resolve, reject };
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost:1455");
      if (u.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<h2>Đăng nhập thất bại: ${err}</h2>`);
        server.close();
        reject(new Error(`OAuth error: ${err}`));
        return;
      }
      const code = u.searchParams.get("code");
      if (!code || u.searchParams.get("state") !== state) {
        res.writeHead(400).end("state không khớp");
        return;
      }
      try {
        const auth = await finish(code);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding-top:60px">` +
            `<h2>✅ Đăng nhập ChatGPT thành công!</h2>` +
            `<p>Tài khoản: ${auth.email ?? auth.accountId}</p>` +
            `<p>Bạn có thể đóng tab này và quay lại PenAI.</p></body>`,
        );
      } catch (e) {
        res.writeHead(500).end((e as Error).message);
        server.close();
        reject(e as Error);
      }
    });

    closeServer = () => {
      if (server.listening) server.close();
    };
    server.on("error", (e) => {
      if (opts.optionalListen) return; // vẫn hoàn tất được bằng submit()
      reject(e);
    });
    server.listen(1455, "127.0.0.1", () => {
      if (openBrowser && process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
        });
      }
    });

    setTimeout(() => {
      closeServer();
      reject(new Error("Hết thời gian chờ đăng nhập"));
    }, timeoutMs).unref();
  });
  // Không để "unhandled rejection" khi caller chỉ dùng submit()
  done.catch(() => {});

  return {
    url,
    state,
    done,
    cancel() {
      closeServer();
      settle.reject(new Error("Phiên đăng nhập đã bị hủy"));
    },
    submit(rawUrlOrCode: string) {
      const parsed = parseCodexCallback(rawUrlOrCode);
      if (parsed.state && parsed.state !== state) {
        throw new Error(
          "Link callback thuộc phiên đăng nhập khác (state không khớp) — bấm Đăng nhập để lấy link mới",
        );
      }
      return finish(parsed.code);
    },
  };
}
