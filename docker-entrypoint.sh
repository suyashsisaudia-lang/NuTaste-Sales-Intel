#!/bin/sh
set -e

# Seed the data directory on first run only. A mounted volume with existing
# data is left untouched, so an uploaded dataset survives redeployment.
if [ ! -f "$DATA_DIR/ar_data.json" ] && [ -d ./seed ]; then
  echo "Seeding $DATA_DIR from bundled datasets"
  cp -n ./seed/*.json "$DATA_DIR"/ 2>/dev/null || true
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips='*'
