#!/usr/bin/env bash
# تركيب نظام جرد السلام على سيرفر Ubuntu/Debian بأمر واحد.
#   sudo bash deploy/install.sh jard.example.com   # مع دومين و HTTPS
#   sudo bash deploy/install.sh                    # بدون دومين (http://IP:3000)
# تقدر تعيد تشغيله أي وقت، ما يمسح البيانات.
set -euo pipefail

DOMAIN="${1:-}"
PORT="${PORT:-3000}"
APP_USER=alsalam
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mخطأ: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "شغّله بـ sudo"
command -v apt-get >/dev/null || die "السكربت يدعم Ubuntu/Debian بس"
[ -f "$APP_DIR/server/index.js" ] || die "شغّله من داخل مجلد النظام"

# النظام يتركب دايمًا في /opt/alsalam/app (مستخدم الخدمة ما يقدر يقرأ /root مثلاً)
TARGET="${ALSALAM_DIR:-/opt/alsalam/app}"
if [ "$APP_DIR" != "$TARGET" ]; then
  if [ ! -f "$TARGET/server/index.js" ]; then
    say "نسخ النظام إلى $TARGET"
    mkdir -p "$(dirname "$TARGET")"
    cp -a "$APP_DIR" "$TARGET"
    rm -rf "$TARGET/node_modules"
  else
    echo "النظام موجود من قبل في $TARGET — بيستخدمه (للتحديث: deploy/update.sh)"
  fi
  exec bash "$TARGET/deploy/install.sh" "$@"
fi

say "تثبيت الأدوات"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null

node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; }
if ! node_ok; then
  say "تثبيت Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "ما قدرت أثبت Node.js 22.5 أو أحدث"
echo "Node $(node -v)"

say "مستخدم النظام وصلاحيات المجلد"
id "$APP_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$APP_USER"
usermod -d "$APP_DIR" "$APP_USER" 2>/dev/null || true
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true

say "تثبيت مكتبات النظام"
sudo -u "$APP_USER" env HOME="$APP_DIR" bash -c "cd '$APP_DIR' && npm ci --cache '$APP_DIR/.npm' --omit=dev --no-audit --no-fund --loglevel=error"

say "تشغيل الخدمة (ترجع لحالها لو السيرفر طفى)"
cat > /etc/systemd/system/alsalam.service <<UNIT
[Unit]
Description=Alsalam restaurant inventory
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) --no-warnings server/index.js
Environment=PORT=$PORT
Environment=HOST=$([ -n "$DOMAIN" ] && echo 127.0.0.1 || echo 0.0.0.0)
Environment=NODE_ENV=production
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable alsalam >/dev/null 2>&1
systemctl restart alsalam

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/login-users" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/login-users" >/dev/null 2>&1 || { journalctl -u alsalam -n 30 --no-pager; die "الخدمة ما اشتغلت"; }
echo "الخدمة شغالة على البورت $PORT"

ufw_on() { command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; }

if [ -n "$DOMAIN" ]; then
  say "HTTPS للدومين $DOMAIN"
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq caddy >/dev/null 2>&1 || {
      # النسخ القديمة من Ubuntu: من مستودع Caddy الرسمي
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    }
  fi
  [ -f /etc/caddy/Caddyfile ] && ! grep -q "alsalam" /etc/caddy/Caddyfile && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
  cat > /etc/caddy/Caddyfile <<CADDY
# alsalam
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:$PORT
}
CADDY
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  ufw_on && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
  URL="https://$DOMAIN"
else
  ufw_on && ufw allow "$PORT/tcp" >/dev/null
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  URL="http://$IP:$PORT"
fi

say "نسخة احتياطية يومية (الساعة 4:30 الفجر، تحتفظ بآخر 30 يوم)"
chmod +x "$APP_DIR/deploy/"*.sh
cat > /etc/cron.d/alsalam-backup <<CRON
30 4 * * * root $APP_DIR/deploy/backup.sh >> /var/log/alsalam-backup.log 2>&1
CRON
"$APP_DIR/deploy/backup.sh" >/dev/null && echo "أول نسخة انحفظت في /opt/backup/alsalam"

say "خلصنا ✓"
cat <<DONE
افتح: $URL
ادخل باسم «المالك» والرقم السري 1234، وغيّر كل الأرقام السرية على طول.

أوامر مفيدة:
  sudo systemctl status alsalam          حالة النظام
  sudo journalctl -u alsalam -f          السجل
  sudo bash $APP_DIR/deploy/update.sh    التحديث
DONE
