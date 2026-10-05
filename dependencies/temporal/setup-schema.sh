#!/bin/sh
# ABOUTME: Подготавливает обе PostgreSQL-схемы официальным инструментом Temporal.
# ABOUTME: Запускается явно; сохраняет существующие данные и версии схем.
set -eu
: "${POSTGRES_SEEDS:?Set PostgreSQL hostname}"
: "${POSTGRES_USER:?Set PostgreSQL user}"
: "${SQL_PASSWORD:?Supply the protected database password}"
for database in temporal temporal_visibility; do
  if [ "$database" = temporal ]; then
    schema=temporal
  else
    schema=visibility
  fi
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p 5432 --db "$database" setup-schema -v 0.0
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p 5432 --db "$database" update-schema -d "/etc/temporal/schema/postgresql/v12/$schema/versioned"
done
