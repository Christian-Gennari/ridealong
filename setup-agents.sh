#!/usr/bin/env bash
# Registers Ridealong with the MCP clients it finds. The installer runs this as
# the agent user; run it yourself after installing one of them later.
set -euo pipefail
APP=/opt/ridealong
. "$APP/config.env"
PATH=$HOME/.local/bin:$PATH

if command -v claude >/dev/null; then
  claude mcp remove playwright --scope user >/dev/null 2>&1 || true
  claude mcp remove ridealong --scope user >/dev/null 2>&1 || true
  claude mcp add ridealong --scope user -- ridealong-mcp --agent Claude
  echo "Claude Code: registered"

  # Tell future sessions how to use the browser. Replaces our block on re-runs.
  mkdir -p "$HOME/.claude"
  python3 - "$HOME/.claude/CLAUDE.md" "$APP/docs/agent-instructions.md" "$VIEWER_URL" <<'PY'
import re, sys
path, source, url = sys.argv[1:]
start, end = "<!-- ridealong -->", "<!-- /ridealong -->"
body = open(source).read().replace("@VIEWER_URL@", url).strip()
block = f"{start}\n{body}\n{end}\n"
try:
    text = open(path).read()
except FileNotFoundError:
    text = ""
text = re.sub(r"<!-- agent-browser -->.*?<!-- /agent-browser -->\n?", "", text, flags=re.S)
pattern = re.compile(re.escape(start) + r".*?" + re.escape(end) + r"\n?", re.S)
if pattern.search(text):
    text = pattern.sub(block, text)
else:
    text = (text.rstrip() + "\n\n" if text.strip() else "") + block
open(path, "w").write(text)
PY
fi

if command -v codex >/dev/null; then
  codex mcp remove ridealong >/dev/null 2>&1 || true
  codex mcp add ridealong -- ridealong-mcp --agent Codex
  echo "Codex: registered"
fi

if command -v gemini >/dev/null; then
  gemini mcp remove --scope user ridealong >/dev/null 2>&1 || true
  # A CLI that can't start must not stop the clients after it.
  if gemini mcp add --scope user ridealong ridealong-mcp -- --agent Gemini >/dev/null 2>&1; then
    echo "Gemini CLI: registered"
  else
    echo "Gemini CLI: skipped, it failed to run. Fix it, then re-run this script."
  fi
fi

CONFIG=$HOME/.hermes/config.yaml
if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.bak-ridealong"
  python3 - "$CONFIG" <<'PY'
import re, sys
path = sys.argv[1]
block = """  ridealong:
    command: /usr/local/bin/ridealong-mcp
    args:
      - --agent
      - Hermes
    timeout: 660
"""
s = open(path).read()
s = re.sub(r"^  (playwright|ridealong):\n(?:^(?:    .*|)\n)*", "", s, flags=re.M)
if re.search(r"^mcp_servers:\n", s, re.M):
    s = re.sub(r"^mcp_servers:\n", "mcp_servers:\n" + block, s, count=1, flags=re.M)
else:
    s = s.rstrip() + "\nmcp_servers:\n" + block
open(path, "w").write(s)
PY
  echo "Hermes: registered. Send /reload-mcp in Hermes, or restart its gateway."
fi
