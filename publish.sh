#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./publish.sh
  ./publish.sh --dry-run

Optional:
  NPM_OTP=123456 ./publish.sh
USAGE
}

if [[ "${1:-}" != "" && "${1:-}" != "--dry-run" ]]; then
  usage
  exit 1
fi

cd "$(dirname "$0")"

publish_cmd=(npm publish --access public)
if [[ "${1:-}" == "--dry-run" ]]; then
  publish_cmd+=(--dry-run)
fi
if [[ -n "${NPM_OTP:-}" ]]; then
  publish_cmd+=(--otp "$NPM_OTP")
fi

echo "Checking npm auth..."
npm whoami >/dev/null

echo "Installing dependencies..."
npm ci

echo "Building package..."
npm run build

echo "Running tests..."
npm test

echo "Publishing wirelog..."
"${publish_cmd[@]}"
