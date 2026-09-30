#!/usr/bin/env bash
# Chạy bằng root mỗi lần dịch vụ PenAI khởi động (ExecStartPre trong
# deploy/templates/penai.service). Chỉ KIỂM TRA rồi thoát ngay: máy chưa có
# Chromium cho tool trình duyệt thì bật việc cài chạy nền (systemd-run gọi
# `penai install-browser`), để dịch vụ không phải chờ tải ~170 MB.
# Nhờ vậy học viên chỉ cần `sudo penai update` như mọi lần.
#
# Tắt tự cài: thêm PENAI_BROWSER_AUTO_INSTALL=0 vào /etc/<bản-cài>/penai.env.
# Luôn thoát 0 — lỗi ở đây không được làm hỏng việc khởi động dịch vụ.
set -u

inst="${1:-}"
[[ $inst =~ ^[a-z][a-z0-9-]{0,30}$ ]] || exit 0
[[ ${PENAI_BROWSER_AUTO_INSTALL:-1} == 0 ]] && exit 0
[[ -n ${CHROME_PATH:-} ]] && exit 0

app="/opt/$inst/app"
pw="$app/packages/tools/node_modules/playwright-core"
[[ -f $pw/cli.js ]] || exit 0
command -v node >/dev/null 2>&1 || exit 0
command -v systemd-run >/dev/null 2>&1 || exit 0

exe="$(PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/penai-browsers}" \
  node -e 'process.stdout.write(require(process.argv[1]).chromium.executablePath())' "$pw" 2>/dev/null || true)"
[[ -n $exe && -x $exe ]] && exit 0

unit="$inst-browser-setup"
systemctl is-active --quiet "$unit" 2>/dev/null && exit 0

# Lần cài trước lỗi chưa tới 6 giờ → không thử lại liên tục mỗi lần khởi động
status="/var/lib/$inst/browser-setup.json"
if [[ -f $status ]] && grep -q '"state":"failed"' "$status" 2>/dev/null \
  && [[ -n $(find "$status" -mmin -360 2>/dev/null) ]]; then
  exit 0
fi

systemctl reset-failed "$unit" >/dev/null 2>&1 || true
systemd-run --unit "$unit" --description "Cài Chromium cho PenAI ($inst)" --collect --no-block \
  /bin/bash "$app/deploy/penai" --instance "$inst" install-browser --quiet >/dev/null 2>&1 || true
exit 0
