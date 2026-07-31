#!/usr/bin/env bash
# Run this from inside the Valkhana web terminal to mark handoff work as
# picked up by the terminal side. Real terminal-side consumer of the
# handoff-status.json file, replacing the browser-button-only path
# (assertTerminalBrowserMutationAuthorized) that a server-side PTY shell
# has no access to (no browser session cookie).
#
# Requires HERMES_HANDOFF_TERMINAL_TOKEN to be set in this shell's
# environment (the operator configures this the same way
# HERMES_HANDOFF_BRAIN_TOKEN is configured for the brain side).
#
# Usage:
#   ./scripts/handoff-pickup.sh terminal-working "Picked up, starting work"
#   ./scripts/handoff-pickup.sh complete "Done"
#   ./scripts/handoff-pickup.sh blocked "Missing input X"

set -euo pipefail

STATE="${1:?Usage: handoff-pickup.sh <terminal-working|blocked|complete> [summary]}"
SUMMARY="${2:-}"

if [ -z "${HERMES_HANDOFF_TERMINAL_TOKEN:-}" ]; then
  echo "HERMES_HANDOFF_TERMINAL_TOKEN is not set in this shell's environment." >&2
  exit 1
fi

BASE_URL="${VALKHANA_URL:-http://127.0.0.1:3000}"

PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'state': sys.argv[1], **({'summary': sys.argv[2]} if len(sys.argv) > 2 and sys.argv[2] else {})}))" "$STATE" "$SUMMARY")

curl -sS -X POST "$BASE_URL/api/internal/handoff/terminal" \
  -H "Authorization: Bearer $HERMES_HANDOFF_TERMINAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
echo
