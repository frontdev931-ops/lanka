#!/usr/bin/env bash
# Database backup into a compressed file. Usage:
#   DATABASE_URL=postgresql://... ./scripts/backup.sh [папка]
# A copy contains patient data: keep it somewhere closed, do not commit it, do not send it by email.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
dir="${1:-backups}"
mkdir -p "$dir"
file="$dir/lanka-$(date +%Y%m%d-%H%M%S).sql.gz"
umask 077
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$file"
echo "Done: $file ($(du -h "$file" | cut -f1))"
# Keep the last 30 copies
ls -1t "$dir"/lanka-*.sql.gz | tail -n +31 | xargs -r rm --
