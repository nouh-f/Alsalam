#!/usr/bin/env bash
# نسخة احتياطية: قاعدة البيانات + صور التذاكر والفواتير. تحتفظ بآخر 30 يوم.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${DATA_DIR:-$APP_DIR/data}"
DEST="${BACKUP_DIR:-/opt/backup/alsalam}"
STAMP="$(date +%F-%H%M)"
mkdir -p "$DEST"
# نسخة آمنة وقاعدة البيانات شغالة (بدون إيقاف الخدمة)
if [ -f "$DATA/alsalam.db" ]; then
  node --no-warnings -e '
    const { DatabaseSync, backup } = require("node:sqlite");
    backup(new DatabaseSync(process.argv[1], { readOnly: true }), process.argv[2]).catch(e => { console.error(e.message); process.exit(1); });
  ' "$DATA/alsalam.db" "$DEST/alsalam-$STAMP.db"
fi
[ -d "$DATA/uploads" ] && tar czf "$DEST/uploads-$STAMP.tgz" -C "$DATA" uploads
find "$DEST" -type f -mtime +30 -delete
echo "$(date '+%F %T') backup ok -> $DEST"
