#!/bin/sh
# Upgrades this deployment to the checkout's newest version, in one command:
# a backup first (asked; --yes takes it without asking, --no-backup skips
# it), then the new image, then `docker compose up`, whose migrate run
# applies the new migrations before the server starts again.
set -eu
cd "$(dirname "$0")"

backup=ask
for arg in "$@"; do
  case "$arg" in
    --yes) backup=yes ;;
    --no-backup) backup=no ;;
    *) echo "usage: $0 [--yes | --no-backup]" >&2; exit 2 ;;
  esac
done
if [ "$backup" = ask ]; then
  if [ -t 0 ]; then
    printf 'Back up the database and secrets first? [Y/n] '
    read -r answer
    case "$answer" in [nN]*) backup=no ;; *) backup=yes ;; esac
  else
    backup=yes
  fi
fi
if [ "$backup" = yes ]; then
  if [ -n "$(docker compose ps -q postgres 2>/dev/null)" ]; then
    ./backup.sh
  else
    echo "Postgres is not running: nothing to back up yet."
  fi
fi

if git -C .. rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C .. pull --ff-only
fi
docker compose build --pull
docker compose up -d --wait
echo "Upgraded. The setup page's health tab tells whether every part answers."
