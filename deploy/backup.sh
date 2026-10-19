#!/bin/sh
# Nightly backup of the AIT dashboard: database dump + uploaded documents. Keeps 14 days.
# cron (root): 30 2 * * * /opt/ait/src/deploy/backup.sh >> /opt/ait/backups/backup.log 2>&1
set -eu
cd /opt/ait
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=/opt/ait/backups
mkdir -p "$DEST" && chmod 700 "$DEST"
docker compose -f src/deploy/docker-compose.yml --project-directory /opt/ait exec -T db pg_dump -U ait -d ait --format=custom > "$DEST/ait-db-$STAMP.dump"
tar -czf "$DEST/ait-documents-$STAMP.tgz" -C /opt/ait documents
chmod 600 "$DEST"/ait-*-"$STAMP".*
find "$DEST" -name 'ait-*' -mtime +14 -delete
echo "$STAMP backup ok ($(du -sh "$DEST" | cut -f1) total)"
