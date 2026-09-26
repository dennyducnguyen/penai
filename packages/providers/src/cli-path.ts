import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Tìm file chạy của một CLI (claude, agy…): lệnh có dấu "/" hoặc là đường dẫn
 * tuyệt đối thì kiểm tra trực tiếp, còn lại dò theo PATH (Windows thêm PATHEXT).
 * Trả null khi chưa cài — Dashboard dùng để báo "chưa cài CLI" thay vì để
 * người dùng bấm đăng nhập rồi nhận lỗi spawn ENOENT khó hiểu.
 */
export function resolveCliCommand(command: string): string | null {
  if (!command) return null;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isFile(command) ? command : null;
  }
  const exts =
    process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}
