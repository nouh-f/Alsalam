#!/usr/bin/env bash
# تحديث النظام لآخر نسخة في GitHub: sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "شغّله بـ sudo" >&2; exit 1; }
"$APP_DIR/deploy/backup.sh"
git -C "$APP_DIR" pull --ff-only
chown -R alsalam:alsalam "$APP_DIR"
sudo -u alsalam env HOME="$APP_DIR" bash -c "cd '$APP_DIR' && npm ci --cache '$APP_DIR/.npm' --omit=dev --no-audit --no-fund --loglevel=error"
# 🗜️ تصغير الصور قبل Claude (sharp) — لازم يشتغل، وإلا الصور تروح بحجمها الكامل (تكلفة أعلى)
if sudo -u alsalam env HOME="$APP_DIR" bash -c "cd '$APP_DIR' && node -e \"require('sharp')({create:{width:20,height:20,channels:3,background:'#fff'}}).jpeg().toBuffer().then(()=>process.exit(0),()=>process.exit(1))\"" ; then echo '✅ sharp شغّال (تصغير الصور)'; else echo '⚠️⚠️ sharp مو شغّال — الصور بتروح بحجمها الكامل! أرسل هالرسالة لـ Claude'; fi
# 🖨️ منفذ «الطابعة» (الكاشير يرسل التذاكر) — لو الجدار الناري شغال
command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active" && ufw allow 9100/tcp >/dev/null || true
# 📄 تقرير اليوم PDF: متصفح بدون شاشة + خط عربي (مرة وحدة)
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null && ! command -v google-chrome >/dev/null; then
  echo "أثبّت المتصفح لتقرير الـPDF (مرة وحدة)…"
  apt-get update -qq || true
  if grep -qi '^ID=debian' /etc/os-release; then apt-get install -y -qq chromium >/dev/null || true
  elif [ "$(dpkg --print-architecture)" = amd64 ]; then
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt-get install -y -qq /tmp/chrome.deb >/dev/null || true; rm -f /tmp/chrome.deb
  else apt-get install -y -qq chromium-browser >/dev/null || apt-get install -y -qq chromium >/dev/null || true; fi
fi
dpkg -s fonts-noto-core >/dev/null 2>&1 || apt-get install -y -qq fonts-noto-core >/dev/null 2>&1 || true
systemctl restart alsalam
sleep 2
systemctl is-active --quiet alsalam && echo "تحدّث ✓" || { journalctl -u alsalam -n 30 --no-pager; exit 1; }
