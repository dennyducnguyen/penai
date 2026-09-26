#!/usr/bin/env bash
# Cài PenAI lên VPS Linux (Ubuntu 22.04/24.04, Debian 12/13) — chạy bằng root.
#
# Cách 1 — một dòng lệnh (máy chủ tự tải script từ GitHub):
#   curl -fsSL https://raw.githubusercontent.com/dennyducnguyen/penai/main/deploy/install.sh \
#     | sudo bash -s -- --domain ai.congty.vn --email admin@congty.vn --yes
#
# Cách 2 — đã clone repo trên máy chủ:
#   sudo bash deploy/install.sh --domain ai.congty.vn --email admin@congty.vn
#
# Script làm gì (chạy lại an toàn, bước nào đã xong thì bỏ qua):
#   gói hệ thống (git, nginx, certbot, bubblewrap, python...) → Node.js 24 + pnpm →
#   PostgreSQL + pgvector → user hệ thống + thư mục → bí mật + file cấu hình →
#   tải mã + cài thư viện + migration + dịch vụ systemd → tài khoản quản trị →
#   Claude Code CLI + Antigravity CLI → nginx + chứng chỉ HTTPS → lệnh `penai`.
#
# Sau khi cài, mọi việc vận hành dùng lệnh: sudo penai help
set -Eeuo pipefail

REPO_URL_DEFAULT="https://github.com/dennyducnguyen/penai.git"
NODE_MAJOR=24
PNPM_VERSION="11.10.0"
PG_MAJOR_DEFAULT=18
NODE_DIR=/opt/node24
PNPM_PREFIX=/opt/pnpm11

if [[ -t 1 ]]; then C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_CYN=$'\e[36m'; C_B=$'\e[1m'; C_OFF=$'\e[0m'
else C_RED=; C_GRN=; C_YEL=; C_CYN=; C_B=; C_OFF=; fi
die()  { printf '\n%sLỗi:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
step() { printf '\n%s[%s]%s %s\n' "$C_CYN" "$1" "$C_OFF" "$2"; }
ok()   { printf '  %s✓%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
trap 'die "Dừng ở dòng $LINENO (lệnh: $BASH_COMMAND). Sửa nguyên nhân rồi chạy lại đúng lệnh cũ — các bước đã xong sẽ được bỏ qua."' ERR

usage() {
  cat <<'EOF'
Cài PenAI lên VPS Linux (Ubuntu 22.04/24.04, Debian 12/13).

Bắt buộc:
  --domain <tên-miền>     Tên miền đã trỏ về IP máy chủ, vd ai.congty.vn
  --email <email>         Email tài khoản quản trị Dashboard + email đăng ký HTTPS

Tùy chọn:
  --instance <tên>        Tên bản cài (mặc định penai) — dùng khi cài nhiều bản trên 1 máy
  --port <cổng>           Cổng nội bộ của ứng dụng (mặc định: cổng trống đầu tiên từ 18800)
  --db-port <cổng>        Cổng PostgreSQL (mặc định 5432)
  --new-pg-cluster        Tạo cụm PostgreSQL riêng cho bản này (máy đã có PenAI khác)
  --repo <url>            Kho mã nguồn (mặc định bản chính thức trên GitHub)
  --ref <tag|nhánh>       Phiên bản cài (mặc định: bản phát hành mới nhất)
  --channel stable|main   stable = bản phát hành (mặc định); main = bản đang phát triển
  --auto-update           Bật tự cập nhật theo kênh đã chọn
  --admin-password <mk>   Mật khẩu quản trị (mặc định sinh ngẫu nhiên, in ra cuối)
  --memory-max <MB>       Giới hạn RAM cho dịch vụ (vd 700) — nên đặt khi máy chạy nhiều thứ
  --no-nginx              Không cấu hình nginx/HTTPS (tự lo reverse proxy)
  --no-ssl                Cấu hình nginx nhưng không xin chứng chỉ HTTPS
  --skip-cli              Không cài Claude Code CLI / Antigravity CLI
  --with-office           Cài thêm LibreOffice (agent chuyển đổi Word/Excel/PowerPoint → PDF)
  --yes                   Không hỏi xác nhận (bắt buộc khi chạy qua SSH không có bàn phím)
EOF
}

# ------------------------------------------------------------------ tham số
INSTANCE="penai"; DOMAIN=""; EMAIL=""; PORT=""; DB_PORT="5432"; NEW_CLUSTER=0; REPO_URL="$REPO_URL_DEFAULT"
REF=""; CHANNEL="stable"; AUTO_UPDATE=0; ADMIN_PASSWORD=""; MEMORY_MAX=""; NO_NGINX=0; NO_SSL=0; SKIP_CLI=0
WITH_OFFICE=0; ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --instance) INSTANCE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --db-port) DB_PORT="${2:-}"; shift 2 ;;
    --new-pg-cluster) NEW_CLUSTER=1; shift ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --auto-update) AUTO_UPDATE=1; shift ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --memory-max) MEMORY_MAX="${2:-}"; shift 2 ;;
    --no-nginx) NO_NGINX=1; NO_SSL=1; shift ;;
    --no-ssl) NO_SSL=1; shift ;;
    --skip-cli) SKIP_CLI=1; shift ;;
    --with-office) WITH_OFFICE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Tham số không hiểu: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Cần chạy bằng root (thêm sudo)"
[[ $INSTANCE =~ ^[a-z][a-z0-9-]{0,30}$ ]] || die "--instance chỉ gồm chữ thường, số, gạch ngang (vd penai, penai-2)"
[[ -n $EMAIL && $EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "Thiếu hoặc sai --email (email quản trị)"
[[ $NO_NGINX == 1 || $DOMAIN =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]] \
  || die "Thiếu hoặc sai --domain (vd ai.congty.vn). Không dùng tên miền thì thêm --no-nginx"
[[ $CHANNEL == stable || $CHANNEL == main ]] || die "--channel chỉ nhận stable hoặc main"
[[ $DB_PORT =~ ^[0-9]+$ ]] || die "--db-port phải là số"
[[ -z $MEMORY_MAX || $MEMORY_MAX =~ ^[0-9]+$ ]] || die "--memory-max tính bằng MB, vd 700"
[[ -z $ADMIN_PASSWORD || ${#ADMIN_PASSWORD} -ge 8 ]] || die "--admin-password tối thiểu 8 ký tự"

APP_USER="$INSTANCE"; BASE_DIR="/opt/$INSTANCE"; ETC_DIR="/etc/$INSTANCE"; DATA_HOME="/var/lib/$INSTANCE"
REPO_DIR="$BASE_DIR/repo.git"; CONF_FILE="$ETC_DIR/penai-install.conf"
DB_NAME="${INSTANCE//-/_}"

if [[ -f $CONF_FILE ]] && grep -q "^INSTALL_COMPLETE=1" "$CONF_FILE"; then
  echo "Bản cài '$INSTANCE' đã có trên máy này (${CONF_FILE})."
  echo "Cập nhật phiên bản: sudo penai --instance $INSTANCE update   ·   Kiểm tra: sudo penai --instance $INSTANCE doctor"
  exit 0
fi

ask() { # ask "câu hỏi" — đọc từ /dev/tty (stdin có thể là chính script khi chạy qua curl | bash)
  [[ $ASSUME_YES == 1 ]] && return 0
  [[ -r /dev/tty ]] || die "Không có bàn phím để xác nhận — chạy lại với --yes"
  local ans; read -r -p "$1 [y/N] " ans < /dev/tty; [[ $ans =~ ^[yYcC] ]]
}

# ------------------------------------------------------------------ kiểm tra máy
step 1/10 "Kiểm tra máy chủ"
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ok "Hệ điều hành: $PRETTY_NAME" ;;
  *) die "Chưa hỗ trợ $PRETTY_NAME — dùng Ubuntu 22.04/24.04 hoặc Debian 12/13" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in x86_64) NODE_ARCH=x64 ;; aarch64) NODE_ARCH=arm64 ;; *) die "Chưa hỗ trợ kiến trúc $ARCH" ;; esac
MEM_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
DISK_GB="$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
(( DISK_GB >= 4 )) || die "Ổ đĩa chỉ còn ${DISK_GB} GB — cần ít nhất 4 GB trống"
ok "RAM ${MEM_MB} MB, ổ đĩa trống ${DISK_GB} GB"
(( MEM_MB >= 1800 )) || warn "RAM dưới 2 GB — PenAI chạy được nhưng chậm; nên dùng máy 2–4 GB"
if [[ -z $(swapon --show --noheadings 2>/dev/null) ]] && (( MEM_MB < 4000 )); then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "Đã tạo swap 2 GB (máy ít RAM)"
  fi
fi
# cài lại sau lần dở dang: giữ đúng cổng đã ghi
[[ -z $PORT && -f $CONF_FILE ]] && PORT="$(sed -n 's/^PORT=//p' "$CONF_FILE")"
if [[ -z $PORT ]]; then
  PORT=18800
  while [[ -n $(ss -ltnH "sport = :$PORT") ]]; do PORT=$((PORT + 10)); done
elif [[ -n $(ss -ltnH "sport = :$PORT") ]] && ! systemctl is-active --quiet "$INSTANCE"; then
  die "Cổng $PORT đang có chương trình khác dùng — chọn --port khác"
fi
ok "Cổng nội bộ của ứng dụng: $PORT"
if [[ -n $DOMAIN ]]; then
  RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  MY_IPS="$(hostname -I 2>/dev/null) $(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z $RESOLVED ]]; then warn "Tên miền $DOMAIN chưa phân giải được — trỏ bản ghi A về IP máy chủ trước khi xin HTTPS"
  else
    match=0; for ip in $RESOLVED; do [[ " $MY_IPS " == *" $ip "* ]] && match=1; done
    if [[ $match == 1 ]]; then ok "Tên miền $DOMAIN trỏ đúng máy này ($RESOLVED)"
    else warn "Tên miền $DOMAIN trỏ về $RESOLVED — có vẻ không phải máy này (${MY_IPS}); xin HTTPS có thể thất bại"; fi
  fi
fi

cat <<EOF

Sắp cài PenAI:
  Bản cài      : $INSTANCE  (mã /opt/$INSTANCE, cấu hình /etc/$INSTANCE, dữ liệu /var/lib/$INSTANCE)
  Địa chỉ      : ${DOMAIN:-"(không cấu hình tên miền)"}
  Quản trị     : $EMAIL
  Nguồn mã     : $REPO_URL (${REF:-kênh $CHANNEL})
  PostgreSQL   : cổng $DB_PORT$([[ $NEW_CLUSTER == 1 ]] && echo " (cụm riêng mới)"), database $DB_NAME
EOF
ask "Tiếp tục cài đặt?" || die "Đã hủy"

# ------------------------------------------------------------------ gói hệ thống
step 2/10 "Cài gói hệ thống (apt)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
PKGS=(ca-certificates curl git gnupg openssl sudo xz-utils bubblewrap python3 python3-pip zip unzip ffmpeg pandoc postgresql-common)
[[ $NO_NGINX == 0 ]] && PKGS+=(nginx)
[[ $NO_SSL == 0 ]] && PKGS+=(certbot python3-certbot-nginx)
apt-get install -y -qq --no-upgrade "${PKGS[@]}" >/dev/null
if [[ $WITH_OFFICE == 1 ]]; then
  apt-get install -y -qq --no-upgrade --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress >/dev/null
  ok "Đã cài LibreOffice"
fi
PIP_FLAGS=(--quiet --disable-pip-version-check)
python3 -m pip install --help 2>/dev/null | grep -q -- --break-system-packages && PIP_FLAGS+=(--break-system-packages)
python3 -m pip install "${PIP_FLAGS[@]}" openpyxl python-docx python-pptx pillow >/dev/null 2>&1 \
  || warn "Chưa cài được thư viện Python cho file Office (openpyxl, python-docx, python-pptx) — agent vẫn chạy, chỉ thiếu khả năng tạo file Office"
ok "Gói hệ thống đã sẵn sàng"

# ------------------------------------------------------------------ Node.js + pnpm
step 3/10 "Node.js $NODE_MAJOR + pnpm"
if [[ -x $NODE_DIR/bin/node ]] && [[ $("$NODE_DIR/bin/node" -p 'process.versions.node.split(".")[0]') == "$NODE_MAJOR" ]]; then
  ok "Dùng Node.js có sẵn: $("$NODE_DIR/bin/node" -v)"
else
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tarball="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$NODE_ARCH.tar.xz" '$2 ~ a"$" {print $2; exit}')"
  [[ -n $tarball ]] || die "Không tìm được bản Node.js $NODE_MAJOR cho $NODE_ARCH"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  curl -fsSL "$base/SHASUMS256.txt" | grep " $tarball\$" | (cd "$tmp" && sha256sum -c --quiet -) || die "Sai mã kiểm tra (checksum) của $tarball"
  tar -xJf "$tmp/$tarball" -C /opt
  ln -sfn "/opt/${tarball%.tar.xz}" "$NODE_DIR"
  rm -rf "$tmp"
  ok "Đã cài $("$NODE_DIR/bin/node" -v) vào $NODE_DIR"
fi
if [[ -x $PNPM_PREFIX/bin/pnpm ]]; then
  ok "Dùng pnpm có sẵn: $("$NODE_DIR/bin/node" "$PNPM_PREFIX/bin/pnpm" -v 2>/dev/null || echo '?')"
else
  PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install -g --silent --prefix "$PNPM_PREFIX" "pnpm@$PNPM_VERSION" >/dev/null
  ok "Đã cài pnpm $PNPM_VERSION vào $PNPM_PREFIX"
fi
PNPM_BIN="$PNPM_PREFIX/bin/pnpm"

# ------------------------------------------------------------------ PostgreSQL + pgvector
step 4/10 "PostgreSQL + pgvector"
psql_at() { sudo -u postgres psql -h /var/run/postgresql -p "$DB_PORT" -v ON_ERROR_STOP=1 -tAq "$@"; }
ensure_pgdg() {
  if ! grep -rqs apt.postgresql.org /etc/apt/sources.list /etc/apt/sources.list.d/; then
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null 2>&1 || die "Không thêm được kho PostgreSQL chính thức (PGDG)"
  fi
}
PG_RUNNING=0
psql_at -d postgres -c 'select 1' >/dev/null 2>&1 && PG_RUNNING=1
if [[ $NEW_CLUSTER == 1 ]]; then
  [[ $PG_RUNNING == 0 ]] || die "Cổng $DB_PORT đã có PostgreSQL chạy — chọn --db-port khác cho cụm riêng"
  PG_MAJOR="$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1)"
  if [[ -z $PG_MAJOR ]]; then ensure_pgdg; apt-get install -y -qq --no-upgrade "postgresql-$PG_MAJOR_DEFAULT" >/dev/null; PG_MAJOR=$PG_MAJOR_DEFAULT; fi
  if ! pg_lsclusters -h | awk '{print $1"/"$2}' | grep -qx "$PG_MAJOR/$INSTANCE"; then
    pg_createcluster "$PG_MAJOR" "$INSTANCE" --port "$DB_PORT" >/dev/null
    # cụm phụ trên máy dùng chung: bộ nhớ đệm nhỏ, ít kết nối
    pg_conftool "$PG_MAJOR" "$INSTANCE" set shared_buffers 64MB
    pg_conftool "$PG_MAJOR" "$INSTANCE" set max_connections 40
  fi
  systemctl enable --now "postgresql@$PG_MAJOR-$INSTANCE" >/dev/null 2>&1 || pg_ctlcluster "$PG_MAJOR" "$INSTANCE" start
  for _ in $(seq 1 20); do psql_at -d postgres -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done
  ok "Cụm PostgreSQL riêng $PG_MAJOR/$INSTANCE trên cổng $DB_PORT"
elif [[ $PG_RUNNING == 1 ]]; then
  ok "Dùng PostgreSQL có sẵn trên cổng $DB_PORT"
else
  ensure_pgdg
  apt-get install -y -qq --no-upgrade "postgresql-$PG_MAJOR_DEFAULT" >/dev/null
  for _ in $(seq 1 20); do psql_at -d postgres -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done
  ok "Đã cài PostgreSQL $PG_MAJOR_DEFAULT"
fi
psql_at -d postgres -c 'select 1' >/dev/null 2>&1 || die "Không kết nối được PostgreSQL trên cổng $DB_PORT"
PG_MAJOR="$(psql_at -d postgres -c 'show server_version_num' | cut -c1-2)"
(( PG_MAJOR >= 16 )) || die "Cần PostgreSQL ≥ 16 (đang có $PG_MAJOR)"
if [[ -z $(psql_at -d postgres -c "select 1 from pg_available_extensions where name='vector'") ]]; then
  ensure_pgdg
  apt-get install -y -qq --no-upgrade "postgresql-$PG_MAJOR-pgvector" >/dev/null || die "Không cài được pgvector cho PostgreSQL $PG_MAJOR"
fi
ok "pgvector sẵn sàng cho PostgreSQL $PG_MAJOR"
# Migration cấp quyền cho role cố định penai_app (role dùng chung cả cụm) → mỗi cụm chỉ chứa MỘT bản PenAI.
if [[ -n $(psql_at -d postgres -c "select 1 from pg_roles where rolname='penai_app'") ]]; then
  for db in $(psql_at -d postgres -c "select datname from pg_database where datistemplate = false and datname not in ('postgres', '$DB_NAME')"); do
    if [[ -n $(psql_at -d "$db" -c "select 1 from information_schema.tables where table_name = 'schema_migrations'" 2>/dev/null) ]]; then
      die "Cụm PostgreSQL cổng $DB_PORT đã chứa một bản PenAI khác (database $db). Cài bản này vào cụm riêng: thêm --new-pg-cluster --db-port 5434"
    fi
  done
fi
DB_PASSWORD="$(openssl rand -hex 24)"
if [[ -n $(psql_at -d postgres -c "select 1 from pg_roles where rolname='penai_app'") ]]; then
  psql_at -d postgres -c "ALTER ROLE penai_app LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
else
  psql_at -d postgres -c "CREATE ROLE penai_app LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
fi
[[ -n $(psql_at -d postgres -c "select 1 from pg_database where datname='$DB_NAME'") ]] \
  || sudo -u postgres createdb -h /var/run/postgresql -p "$DB_PORT" "$DB_NAME"
ok "Database $DB_NAME + role penai_app (mật khẩu ngẫu nhiên)"

# ------------------------------------------------------------------ user + thư mục + mã nguồn
step 5/10 "User hệ thống, thư mục và mã nguồn"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -m 0755 "$BASE_DIR" "$BASE_DIR/releases"
install -d -m 0750 -o root -g "$APP_USER" "$ETC_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_HOME" "$DATA_HOME/data" "$DATA_HOME/codex-accounts" "$DATA_HOME/.local" "$DATA_HOME/.local/bin"
install -d -m 0700 "/var/backups/$INSTANCE"; install -d -m 0750 "/var/log/$INSTANCE"
if [[ ! -d $REPO_DIR ]]; then
  git clone --quiet --mirror "$REPO_URL" "$REPO_DIR" || die "Không tải được mã nguồn từ $REPO_URL"
else
  git --git-dir="$REPO_DIR" fetch --quiet --prune origin
fi
if [[ -z $REF ]]; then
  if [[ $CHANNEL == stable ]]; then
    REF="$(git --git-dir="$REPO_DIR" tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
    [[ -n $REF ]] || { warn "Kho mã chưa có bản phát hành (tag v*) — cài từ nhánh main"; REF=main; }
  else
    REF=main
  fi
fi
SHA="$(git --git-dir="$REPO_DIR" rev-parse --verify --quiet "${REF}^{commit}")" || die "Không có phiên bản '$REF' trong kho mã"
ok "Mã nguồn: $REF @ ${SHA:0:8}"

# ------------------------------------------------------------------ bí mật + cấu hình
step 6/10 "Bí mật và file cấu hình"
bwrap_ok() { sudo -u "$APP_USER" bwrap --ro-bind / / --dev /dev --proc /proc true >/dev/null 2>&1; }
# Ubuntu 23.10+ chặn user namespace với chương trình thường (AppArmor). Không tắt chặn cho cả máy —
# chỉ cấp riêng cho /usr/bin/bwrap, và chỉ khi máy chưa có profile nào cho bwrap.
if ! bwrap_ok && [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null) == 1 ]]    && command -v apparmor_parser >/dev/null && ! grep -rqs '/usr/bin/bwrap' /etc/apparmor.d/; then
  cat > /etc/apparmor.d/penai-bwrap <<'APPARMOR'
# Tạo bởi deploy/install.sh của PenAI: cho bubblewrap tạo user namespace (sandbox lệnh exec của agent)
abi <abi/4.0>,
include <tunables/global>

profile penai-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/penai-bwrap>
}
APPARMOR
  apparmor_parser -r /etc/apparmor.d/penai-bwrap >/dev/null 2>&1 && ok "Cấp quyền AppArmor riêng cho bubblewrap (Ubuntu chặn user namespace)"
fi
if bwrap_ok; then
  SANDBOX=required; ok "Sandbox bubblewrap hoạt động — lệnh exec của agent chạy cách ly"
else
  SANDBOX=auto; warn "bubblewrap không chạy được trên máy này (VPS chặn user namespace) — lệnh exec của agent sẽ chạy KHÔNG cách ly"
fi
if [[ $NO_NGINX == 1 ]]; then PUBLIC_URL="http://$(hostname -I | awk '{print $1}'):$PORT"
elif [[ $NO_SSL == 1 ]]; then PUBLIC_URL="http://$DOMAIN"
else PUBLIC_URL="https://$DOMAIN"; fi
if (( MEM_MB >= 3800 )); then CLI_TOTAL=2; else CLI_TOTAL=1; fi
umask 0027
if [[ ! -f $ETC_DIR/penai.env ]]; then
  {
    echo "# Bí mật của PenAI ($INSTANCE) — tạo lúc cài. KHÔNG đổi PENAI_MASTER_KEY: mất khóa = mất mọi token/API key đã lưu."
    echo "NODE_ENV=production"
    echo "DATABASE_URL=postgresql://penai_app:$DB_PASSWORD@127.0.0.1:$DB_PORT/$DB_NAME"
    echo "PENAI_MASTER_KEY=$(openssl rand -base64 32)"
    echo "PENAI_PUBLIC_URL=$PUBLIC_URL"
    echo "PENAI_CONFIG=$ETC_DIR/penai.config.json5"
    echo "PENAI_EXEC_SANDBOX=$SANDBOX"
    echo "PENAI_LANE_MAIN=4"
    echo "LOG_LEVEL=info"
  } > "$ETC_DIR/penai.env"
else
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://penai_app:$DB_PASSWORD@127.0.0.1:$DB_PORT/$DB_NAME#" "$ETC_DIR/penai.env"
fi
chown root:"$APP_USER" "$ETC_DIR/penai.env"; chmod 0640 "$ETC_DIR/penai.env"
cat > "$CONF_FILE" <<EOF
# Thông tin bản cài PenAI — lệnh 'penai' đọc file này. Tạo bởi deploy/install.sh.
REPO_URL=$REPO_URL
CHANNEL=$CHANNEL
DOMAIN=$DOMAIN
PUBLIC_URL=$PUBLIC_URL
PORT=$PORT
DB_NAME=$DB_NAME
DB_PORT=$DB_PORT
APP_USER=$APP_USER
MEMORY_MAX=$MEMORY_MAX
CLI_TOTAL=$CLI_TOTAL
NODE_DIR=$NODE_DIR
PNPM_BIN=$PNPM_BIN
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chown root:"$APP_USER" "$CONF_FILE"; chmod 0640 "$CONF_FILE"
umask 0022
# lệnh quản trị 'penai' lấy từ đúng phiên bản sắp cài
git --git-dir="$REPO_DIR" show "$SHA:deploy/penai" > /usr/local/bin/penai.new && chmod 0755 /usr/local/bin/penai.new && mv -f /usr/local/bin/penai.new /usr/local/bin/penai
if [[ ! -f $ETC_DIR/penai.config.json5 ]]; then
  tpl="$(git --git-dir="$REPO_DIR" show "$SHA:deploy/templates/penai.config.json5")"
  tpl="${tpl//\{\{INSTANCE\}\}/$INSTANCE}"; tpl="${tpl//\{\{PORT\}\}/$PORT}"
  tpl="${tpl//\{\{DATA_HOME\}\}/$DATA_HOME}"; tpl="${tpl//\{\{CLI_TOTAL\}\}/$CLI_TOTAL}"
  printf '%s\n' "$tpl" > "$ETC_DIR/penai.config.json5"
  chown root:"$APP_USER" "$ETC_DIR/penai.config.json5"; chmod 0640 "$ETC_DIR/penai.config.json5"
fi
ok "Bí mật: $ETC_DIR/penai.env · Cấu hình: $ETC_DIR/penai.config.json5"

# ------------------------------------------------------------------ triển khai phiên bản
step 7/10 "Cài thư viện, nâng cấp database, khởi động dịch vụ (vài phút)"
penai --instance "$INSTANCE" update --ref "$REF" --yes --no-backup --force
rel="$(readlink -f "$BASE_DIR/app")"

step 8/10 "Tài khoản quản trị"
GENERATED=0
if [[ -z $ADMIN_PASSWORD ]]; then ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"; GENERATED=1; fi
(cd "$rel" && sudo -u postgres env HOME=/tmp PATH="$NODE_DIR/bin:/usr/bin:/bin" PGPORT="$DB_PORT" \
  DATABASE_URL_ADMIN="postgresql:///$DB_NAME?host=/var/run/postgresql" PENAI_USER_PASSWORD="$ADMIN_PASSWORD" \
  "$rel/node_modules/.bin/tsx" packages/db/src/cli-setup.ts --email "$EMAIL")

step 9/10 "Claude Code CLI + Antigravity CLI"
if [[ $SKIP_CLI == 1 ]]; then warn "Bỏ qua (--skip-cli). Cài sau: sudo penai --instance $INSTANCE install-cli all"
else penai --instance "$INSTANCE" install-cli all || warn "Cài CLI chưa xong — thử lại: sudo penai --instance $INSTANCE install-cli all"; fi

step 10/10 "nginx + HTTPS"
if [[ $NO_NGINX == 1 ]]; then
  warn "Bỏ qua nginx (--no-nginx). Ứng dụng nghe tại 127.0.0.1:$PORT — tự cấu hình reverse proxy."
else
  if [[ -d /etc/nginx/sites-available ]]; then VHOST="/etc/nginx/sites-available/$DOMAIN"; LINK="/etc/nginx/sites-enabled/$DOMAIN"
  else VHOST="/etc/nginx/conf.d/$DOMAIN.conf"; LINK=""; fi
  if [[ -e $VHOST ]]; then
    warn "Đã có cấu hình nginx $VHOST — giữ nguyên, không ghi đè"
  else
    tpl="$(git --git-dir="$REPO_DIR" show "$SHA:deploy/templates/nginx.conf")"
    tpl="${tpl//\{\{INSTANCE\}\}/$INSTANCE}"; tpl="${tpl//\{\{DOMAIN\}\}/$DOMAIN}"; tpl="${tpl//\{\{PORT\}\}/$PORT}"
    tpl="${tpl//\{\{NGINX_ID\}\}/${INSTANCE//[^a-zA-Z0-9]/_}}"
    printf '%s\n' "$tpl" > "$VHOST"
    [[ -n $LINK ]] && ln -sfn "$VHOST" "$LINK"
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx; ok "nginx: $VHOST"
    else rm -f "$VHOST" ${LINK:+"$LINK"}; nginx -t || true; die "Cấu hình nginx lỗi — đã gỡ file vừa tạo"; fi
  fi
  if command -v ufw >/dev/null && [[ $(ufw status 2>/dev/null) == *"Status: active"* ]]; then ufw allow 'Nginx Full' >/dev/null && ok "Mở cổng 80/443 trên tường lửa ufw"; fi
  if [[ $NO_SSL == 0 ]]; then
    if certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect -n >/tmp/penai-certbot.log 2>&1; then
      ok "Chứng chỉ HTTPS Let's Encrypt cho $DOMAIN (tự gia hạn)"
    else
      tail -n 5 /tmp/penai-certbot.log >&2
      warn "Chưa xin được HTTPS (tên miền chưa trỏ đúng / cổng 80 bị chặn?). Tạm dùng http://$DOMAIN. Xin lại sau: sudo certbot --nginx -d $DOMAIN"
      PUBLIC_URL="http://$DOMAIN"
      sed -i "s#^PENAI_PUBLIC_URL=.*#PENAI_PUBLIC_URL=$PUBLIC_URL#" "$ETC_DIR/penai.env"
      sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=$PUBLIC_URL#" "$CONF_FILE"
      systemctl restart "$INSTANCE"
    fi
  fi
fi
if [[ $AUTO_UPDATE == 1 ]]; then penai --instance "$INSTANCE" auto-update on --channel "$CHANNEL"; fi
echo "INSTALL_COMPLETE=1" >> "$CONF_FILE"

trap - ERR
cat <<EOF

${C_GRN}${C_B}Cài đặt PenAI hoàn tất!${C_OFF}

  Địa chỉ     : ${C_B}$PUBLIC_URL${C_OFF}
  Đăng nhập   : $EMAIL
EOF
if [[ $GENERATED == 1 ]]; then
  echo "  Mật khẩu    : ${C_B}$ADMIN_PASSWORD${C_OFF}   ← chỉ hiện MỘT lần, hãy lưu lại ngay"
else
  echo "  Mật khẩu    : (mật khẩu bạn đã đặt bằng --admin-password)"
fi
cat <<EOF

Bước tiếp theo trong Dashboard:
  1. Providers → đăng nhập ChatGPT, Claude hoặc Antigravity (hoặc thêm provider bằng API key)
  2. Agents → mở agent "Trợ lý" → chọn provider/model bạn có → Lưu
  3. Chat → nhắn thử; Channels → kết nối Telegram / Zalo / Teams...

Vận hành trên máy chủ:
  sudo penai status          xem phiên bản + trạng thái
  sudo penai update          cập nhật bản mới (tự sao lưu, lỗi thì tự quay lại)
  sudo penai doctor          kiểm tra sức khỏe hệ thống
  sudo penai help            mọi lệnh khác
EOF
