#!/usr/bin/env bash
# Points Claude Code and Hermes at the wrapper. The installer runs this as the
# agent user; run it yourself after installing either of them later.
set -euo pipefail
APP=/opt/agent-browser
. "$APP/config.env"
PATH=$HOME/.local/bin:$PATH
WRAPPER=$APP/mcp/agent-browser-mcp.mjs
OUT=$HOME/.cache/playwright-mcp
NODE_BIN=$APP/node/bin
MCP_PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
VIEWER=http://127.0.0.1:$VIEWER_PORT
mkdir -p -m 700 "$OUT"

if command -v claude >/dev/null; then
  claude mcp remove playwright --scope user >/dev/null 2>&1 || true
  claude mcp add playwright --scope user \
    -e "PATH=$MCP_PATH" -e "AGENT_BROWSER_VIEWER=$VIEWER" -e "VIEWER_TOKEN=${VIEWER_TOKEN:-}" -- \
    "$NODE_BIN/node" "$WRAPPER" --agent Claude -- \
    "$NODE_BIN/npx" -y @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222 --output-dir "$OUT"
  echo "Claude Code: registered"

  # Tell future sessions how to use the browser. Replaces our block on re-runs.
  mkdir -p "$HOME/.claude"
  python3 - "$HOME/.claude/CLAUDE.md" "$APP/docs/agent-instructions.md" "$VIEWER_URL" <<'PY'
import re, sys
path, source, url = sys.argv[1:]
start, end = "<!-- agent-browser -->", "<!-- /agent-browser -->"
body = open(source).read().replace("@VIEWER_URL@", url).strip()
block = f"{start}\n{body}\n{end}\n"
try:
    text = open(path).read()
except FileNotFoundError:
    text = ""
pattern = re.compile(re.escape(start) + r".*?" + re.escape(end) + r"\n?", re.S)
if pattern.search(text):
    text = pattern.sub(block, text)
else:
    text = (text.rstrip() + "\n\n" if text.strip() else "") + block
open(path, "w").write(text)
PY
fi

CONFIG=$HOME/.hermes/config.yaml
if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.bak-agent-browser"
  python3 - "$CONFIG" "$NODE_BIN" "$WRAPPER" "$OUT" "$MCP_PATH" "$VIEWER" "${VIEWER_TOKEN:-}" <<'PY'
import re, sys
path, node, wrapper, out, mcp_path, viewer, token = sys.argv[1:]
block = f"""  playwright:
    command: {node}/node
    args:
      - {wrapper}
      - --agent
      - Hermes
      - --
      - {node}/npx
      - -y
      - '@playwright/mcp@latest'
      - --cdp-endpoint
      - http://127.0.0.1:9222
      - --output-dir
      - {out}
    env:
      PATH: {mcp_path}
      AGENT_BROWSER_VIEWER: {viewer}
      VIEWER_TOKEN: '{token}'
    timeout: 660
"""
s = open(path).read()
existing = re.compile(r"^  playwright:\n(?:^(?:    .*|)\n)*", re.M)
if existing.search(s):
    s = existing.sub(block, s, count=1)
elif re.search(r"^mcp_servers:\n", s, re.M):
    s = re.sub(r"^mcp_servers:\n", "mcp_servers:\n" + block, s, count=1, flags=re.M)
else:
    s = s.rstrip() + "\nmcp_servers:\n" + block
open(path, "w").write(s)
PY
  echo "Hermes: registered. Send /reload-mcp in Hermes, or restart its gateway."
fi
