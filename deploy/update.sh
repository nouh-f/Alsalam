#!/usr/bin/env bash
# تحديث النظام لآخر نسخة في GitHub: sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "شغّله بـ sudo" >&2; exit 1; }
"$APP_DIR/deploy/backup.sh"
git -C "$APP_DIR" pull --ff-only
chown -R alsalam:alsalam "$APP_DIR"
sudo -u alsalam env HOME="$APP_DIR" bash -c "cd '$APP_DIR' && npm ci --cache '$APP_DIR/.npm' --omit=dev --no-audit --no-fund --loglevel=error"
systemctl restart alsalam
sleep 2
systemctl is-active --quiet alsalam && echo "تحدّث ✓" || { journalctl -u alsalam -n 30 --no-pager; exit 1; }
