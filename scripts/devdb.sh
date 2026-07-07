#!/usr/bin/env bash
# Fallback local database for environments that cannot run `supabase start`
# (no Docker, e.g. restricted cloud containers). Creates/starts a plain
# Postgres 16 cluster and prints the DATABASE_URL to use.
# On a normal dev machine prefer: supabase start
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${PGPORT:-55499}"
PGDATA="${PGDATA:-$HOME/.exitblueprint-pgdata}"
DBNAME="exit_blueprint"

run() {
  if [ "$(id -u)" = "0" ]; then
    # Postgres refuses to run as root; delegate to an unprivileged user.
    id pg >/dev/null 2>&1 || useradd -m -s /bin/bash pg
    su pg -c "PGDATA=/home/pg/.exitblueprint-pgdata $PGBIN/$1 ${*:2}"
  else
    "$PGBIN/$1" "${@:2}"
  fi
}

if [ "$(id -u)" = "0" ]; then
  PGDATA=/home/pg/.exitblueprint-pgdata
fi

# Reuse an already-listening server on the port (idempotent re-runs, or a
# cluster started some other way); otherwise init/start our own.
if ! "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q 2>/dev/null; then
  if [ ! -d "$PGDATA" ]; then
    run initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
  fi
  if ! run pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    run pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -o "'-p $PGPORT -k /tmp'" start >/dev/null
  fi
fi

psql -h 127.0.0.1 -p "$PGPORT" -U postgres -tc \
  "select 1 from pg_database where datname = '$DBNAME'" | grep -q 1 ||
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -c "create database $DBNAME" >/dev/null

echo "DATABASE_URL=postgresql://postgres@127.0.0.1:$PGPORT/$DBNAME"
