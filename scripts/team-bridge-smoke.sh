#!/usr/bin/env bash
# Real-CLI team-bridge smoke: drives a real opencode rob and a real claude rob
# through `my-agent team` and fails unless each one calls send_message end to
# end. Needs DEEPSEEK_API_KEY and network; it makes a few small model calls.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tsx="$repo/node_modules/.bin/tsx"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "skip: DEEPSEEK_API_KEY is not set" >&2
  exit 0
fi

ws="$(mktemp -d "${TMPDIR:-/tmp}/my-agent-bridge-XXXXXX")"
trap 'rm -rf "$ws"' EXIT

cat > "$ws/my-agent.json" <<'JSON'
{
  "provider": { "preset": "deepseek", "model": "deepseek-v4-flash" },
  "robs": [
    { "name": "sink", "role": "Receive direct messages and do nothing else." },
    { "name": "cc", "role": "You follow the instruction and call the requested tool exactly once.",
      "backend": { "kind": "cli", "command": "claude" } },
    { "name": "oc", "role": "You follow the instruction and call the requested tool exactly once.",
      "backend": { "kind": "cli", "command": "opencode", "provider": "deepseek", "model": "deepseek-v4-flash" } }
  ]
}
JSON

run_rob() {
  local rob="$1" prompt="$2" expected=""
  echo "--- $rob ---"
  out="$(cd "$ws" && "$tsx" "$repo/src/index.ts" team \
    --dispatch "$rob=$prompt" --wait-ms 190000 --yes 2>&1)"
  echo "$out" | sed -n '/=== DMs ===/,/===/p'
  expected="$rob -> sink:"
  if ! grep -qF "$expected" <<<"$out"; then
    echo "FAIL: $rob did not send the DM" >&2
    return 1
  fi
  echo "PASS: $rob"
}

run_rob cc "Call the send_message tool exactly once with to=\"sink\" and text=\"pong-claude\". Then finish."

run_rob oc "The team tool is exposed through Code Mode as tools[\"myagent-team\"].send_message(to, text). If the tool catalog looks empty, re-query it until the myagent-team tools appear, then call send_message with to=\"sink\" and text=\"pong-opencode\". Then finish."

echo "bridge smoke: all robs replied"
