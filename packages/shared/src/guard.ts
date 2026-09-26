/**
 * Input guard — phát hiện prompt injection cơ bản bằng regex.
 * Mode: off (bỏ qua) | log (chỉ ghi) | warn (thêm cảnh báo vào ngữ cảnh) | block (chặn).
 */
export type GuardMode = "off" | "log" | "warn" | "block";

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ignore_instructions", re: /\b(ignore|disregard|bỏ qua|quên|phớt lờ)\b.{0,40}\b(instruction|prompt|rule|system|previous|above|prior|chỉ thị|hướng dẫn|quy tắc|lệnh|hệ thống|trước)/i },
  { name: "reveal_system_prompt", re: /\b(reveal|show|print|repeat|in ra|tiết lộ|hiển thị)\b.{0,30}\b(system prompt|system message|your instructions|prompt hệ thống|chỉ thị của bạn)/i },
  { name: "role_override", re: /\byou are now\b|\bfrom now on you\b|\bact as (?:a )?(?:dan|jailbroken|unrestricted)\b|\bbạn bây giờ là\b/i },
  { name: "developer_mode", re: /\b(developer mode|jailbreak|dan mode|bypass (?:your )?(?:restrictions|safety|filter))\b/i },
  { name: "exfil_secrets", re: /\b(print|show|reveal|gửi|leak|dump)\b.{0,25}\b(api[_ ]?key|password|secret|token|env|biến môi trường|mật khẩu)\b/i },
  { name: "override_delimiters", re: /(-{3,}\s*end of|<\/?system>|\[\/?system\]|###\s*system)/i },
];

export interface GuardResult {
  flagged: boolean;
  matches: string[];
  /** true nếu mode=block và có match → nên chặn. */
  blocked: boolean;
}

export function checkInput(text: string, mode: GuardMode = "warn"): GuardResult {
  if (mode === "off") return { flagged: false, matches: [], blocked: false };
  const matches: string[] = [];
  for (const p of PATTERNS) if (p.re.test(text)) matches.push(p.name);
  const flagged = matches.length > 0;
  return { flagged, matches, blocked: flagged && mode === "block" };
}
