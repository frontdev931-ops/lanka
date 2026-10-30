#!/usr/bin/env bash
# Restore the database from a copy. It REPLACES data in the target database: run it only on an empty database or deliberately.
#   DATABASE_URL=postgresql://... ./scripts/restore.sh backups/lanka-....sql.gz
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
file="${1:?give the backup file}"
read -r -p "Data in the target database will be replaced. Continue? (type yes) " answer
[ "$answer" = "yes" ] || { echo "Cancelled"; exit 1; }
gunzip -c "$file" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
echo "Restored from $file"
