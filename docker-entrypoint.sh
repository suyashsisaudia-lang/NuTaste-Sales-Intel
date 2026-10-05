#!/bin/sh
set -e

# Seed the data directory on first run only. A mounted volume with existing
# data is left untouched, so an uploaded dataset survives redeployment.
if [ ! -f "$DATA_DIR/ar_data.json" ] && [ -d ./seed ]; then
  echo "Seeding $DATA_DIR from bundled datasets"
  cp -n ./seed/*.json "$DATA_DIR"/ 2>/dev/null || true
fi

# Secondary Sales is refreshed on the office PC, which commits and pushes it to
# GitHub (app/data_sync.py); each push redeploys this image. So the bundled copy
# is always the newest: overwrite it on every boot, disk or no disk, and bring
# every month across, not just the latest. credentials.json is never touched.
if [ -d ./seed ]; then
  for f in sec_data.json meta.json; do
    if [ -f "./seed/$f" ]; then cp "./seed/$f" "$DATA_DIR/$f"; fi
  done
  if [ -d ./seed/sec_months ]; then
    mkdir -p "$DATA_DIR/sec_months"
    cp ./seed/sec_months/*.json "$DATA_DIR/sec_months"/
  fi
  echo "Loaded Secondary Sales from the image: $(ls ./seed/sec_months 2>/dev/null | wc -l) months"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips='*'
