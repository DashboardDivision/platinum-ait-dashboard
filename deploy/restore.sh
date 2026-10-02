#!/bin/sh
# Restore a backup made by backup.sh. Stops the app, restores, starts it again.
# usage: deploy/restore.sh 20261003T023000Z
set -eu
STAMP=${1:?usage: restore.sh <backup stamp>}
cd /opt/ait
SRC=/opt/ait/backups
[ -f "$SRC/ait-db-$STAMP.dump" ] || { echo "no backup $STAMP"; exit 1; }
docker compose -f deploy/docker-compose.yml stop app
docker compose -f deploy/docker-compose.yml exec -T db pg_restore -U ait -d ait --clean --if-exists --no-owner < "$SRC/ait-db-$STAMP.dump"
if [ -f "$SRC/ait-documents-$STAMP.tgz" ]; then
  mv documents "documents.before-restore-$(date -u +%s)"
  tar -xzf "$SRC/ait-documents-$STAMP.tgz" -C /opt/ait
fi
docker compose -f deploy/docker-compose.yml start app
echo "restored $STAMP"
