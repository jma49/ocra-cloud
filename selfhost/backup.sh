#!/bin/sh
# Backs up this deployment into backups/<UTC time>/: the database (pg_dump)
# and the secrets volume, whose master key alone opens the keys the database
# holds. docs/self-hosting.md, Backups, says how to restore them.
set -eu
cd "$(dirname "$0")"

at="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$at"
chmod 700 backups "$at"
docker compose exec -T postgres pg_dump -U ocra -d ocra -Fc > "$at/ocra.dump"
docker compose run --rm --no-deps -T secrets tar -cf - -C / secrets db-password > "$at/secrets.tar"
chmod 600 "$at/ocra.dump" "$at/secrets.tar"
echo "Backed up to selfhost/$at: keep it somewhere else too."
