#!/bin/sh
# Container entrypoint: optionally load the demo store, then serve the app.
set -e
mkdir -p "${DATA_DIR:-data}"
if [ -n "$SEED_DEMO" ]; then
  # Idempotent: pieces already in the store are skipped.
  python -m scripts.seed_ringfir demo/ringfir --store demo --create "${DEMO_STORE_NAME:-Maison Aurelia}"
fi
# One process: try-ons run as in-process background tasks and the default database is SQLite.
# --proxy-headers so links and QR codes use https behind the host's load balancer.
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips "*"
