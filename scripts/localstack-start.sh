#!/usr/bin/env bash
# Start LocalStack (SQS/S3/SNS/API GW) for local dev. See CDP-BUILD-SPEC.md §15.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d
echo "LocalStack edge listening on http://127.0.0.1:4566"
