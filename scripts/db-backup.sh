#!/usr/bin/env bash
#
# scripts/db-backup.sh — pre-upgrade database backup helper.
#
# This is the tool the Phase 6 dogfood runbook (docs/phase-6-dogfood-runbook.md)
# invokes at Step 2 to satisfy docs/UPGRADING.md rule 1: "Back up the database.
# This is your only rollback." It is INERT by design — it does NOTHING unless the
# operator passes an explicit DATABASE_URL. It never reads apps/api/.env, never
# falls back to a default, and never targets any live database on its own.
#
# Usage:
#   scripts/db-backup.sh "$PROD_DATABASE_URL"
#   # or
#   DATABASE_URL="$PROD_DATABASE_URL" scripts/db-backup.sh
#
# Output:
#   backups/hogsend-<ISO8601-UTC>.dump   (pg_dump custom format, -Fc)
#
# After it writes the dump it prints the EXACT pg_restore command that rolls the
# database back to this snapshot — the last-resort rollback path in UPGRADING.md.

set -euo pipefail

# --- 1. Require an explicit DATABASE_URL (arg wins, then env). Refuse otherwise.
DB_URL="${1:-${DATABASE_URL:-}}"

if [[ -z "${DB_URL}" ]]; then
  cat >&2 <<'EOF'
ERROR: no database URL supplied.

This script will not guess a target. Pass the URL explicitly so a backup can
NEVER hit the wrong database:

  scripts/db-backup.sh "postgresql://user:pass@host:5432/dbname"

or via the environment:

  DATABASE_URL="postgresql://user:pass@host:5432/dbname" scripts/db-backup.sh

(Refusing to read apps/api/.env or any default. UPGRADING.md rule 1.)
EOF
  exit 1
fi

# --- 2. Require pg_dump / pg_restore to be on PATH.
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found on PATH. Install the PostgreSQL client tools." >&2
  exit 1
fi

# --- 3. Compute paths. Backups land in <repo-root>/backups (gitignored).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${REPO_ROOT}/backups"
mkdir -p "${BACKUP_DIR}"

# ISO8601 UTC, filesystem-safe (no colons).
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/hogsend-${STAMP}.dump"

# --- 4. Dump. Custom format (-Fc) so pg_restore can do selective/parallel restore.
echo "Backing up to ${OUT} ..."
pg_dump -Fc --no-owner --no-privileges --dbname="${DB_URL}" --file="${OUT}"

# --- 5. Report + print the exact rollback command.
SIZE="$(du -h "${OUT}" | cut -f1)"
echo
echo "Backup complete: ${OUT} (${SIZE})"
echo
echo "Verify the dump lists objects with:"
echo "  pg_restore -l \"${OUT}\" | head"
echo
echo "ROLLBACK (last resort — restores this snapshot, drops everything written"
echo "since; UPGRADING.md rollback policy). Restore into the SAME database:"
echo
echo "  pg_restore --clean --if-exists --no-owner --no-privileges \\"
echo "    --dbname=\"\$TARGET_DATABASE_URL\" \"${OUT}\""
echo
echo "Prefer roll-forward (a corrective migration) over restore whenever possible."
