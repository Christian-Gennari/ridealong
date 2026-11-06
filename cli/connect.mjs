// Registers Ridealong with the MCP clients it finds. `ridealong up` does this the
// first time, and `ridealong connect` after you install another client.
import fs from "node:fs";
import path from "node:path";
import { run, which } from "./lib.mjs";

const START = "<!-- ridealong -->";
const END = "<!-- /ridealong -->";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BLOCK = new RegExp(`\\n*${escape(START)}[\\s\\S]*?${escape(END)}\\n?`);

// Our block in ~/.claude/CLAUDE.md, replaced on re-runs. Drops the block an older
// install (agent-browser) left behind.
export const withClaudeBlock = (text, instructions, url) => {
  const body = instructions.split("@VIEWER_URL@").join(url).trim();
  const block = `${START}\n${body}\n${END}\n`;
  let out = text.replace(/<!-- agent-browser -->[\s\S]*?<!-- \/agent-browser -->\n?/, "");
  const pattern = new RegExp(`${escape(START)}[\\s\\S]*?${escape(END)}\\n?`);
  if (pattern.test(out)) return out.replace(pattern, () => block);
  return (out.trim() ? out.replace(/\s+$/, "") + "\n\n" : "") + block;
};
export const withoutClaudeBlock = (text) => text.replace(BLOCK, "\n");

// Codex gives up on a tool after 60 seconds, and a handover can wait 10 minutes.
// `codex exec` has no one to approve a tool call, so it needs approve mode too.
export const withCodexSettings = (toml) => {
  const header = /^\[mcp_servers\.ridealong\]\r?\n/m;
  const m = toml.match(header);
  if (!m) return toml;
  const start = m.index + m[0].length;
  const next = toml.slice(start).search(/^\[/m);
  const section = next < 0 ? toml.slice(start) : toml.slice(start, start + next);
  const add = [
    /^tool_timeout_sec\s*=/m.test(section) ? "" : "tool_timeout_sec = 660\n",
    /^default_tools_approval_mode\s*=/m.test(section) ? "" : 'default_tools_approval_mode = "approve"\n',
  ].join("");
  return toml.slice(0, start) + add + toml.slice(start);
};

const yamlString = (s) => /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
const HERMES_ENTRY = /^ {2}(playwright|ridealong):\r?\n(?:(?: {4}.*|)\r?\n)*/gm;

export const withHermesServer = (yaml, command, args) => {
  const block = `  ridealong:\n    command: ${yamlString(command)}\n    args:\n` +
    args.map((a) => `      - ${yamlString(a)}\n`).join("") + "    timeout: 660\n";
  const s = yaml.replace(HERMES_ENTRY, "");
  if (/^mcp_servers:\r?\n/m.test(s)) return s.replace(/^mcp_servers:\r?\n/m, (h) => h + block);
  return s.replace(/\s*$/, "") + "\nmcp_servers:\n" + block;
};
export const withoutHermesServer = (yaml) => yaml.replace(/^ {2}ridealong:\r?\n(?:(?: {4}.*|)\r?\n)*/gm, "");

const quiet = (cmd, args) => run(cmd, args, { timeout: 60000 });
const edit = (file, change) => {
  if (!fs.existsSync(file)) return false;
  fs.writeFileSync(file, change(fs.readFileSync(file, "utf8")));
  return true;
};

// command + prefix is how an MCP client starts `ridealong` (see mcpCommand in main.mjs).
export const connect = ({ home, url, command, prefix, instructions, log = console.log, remove = false }) => {
  const has = (name) => Boolean(which(name));
  const agent = (name) => [...prefix, "mcp", "--agent", name];
  const claudeMd = path.join(home, ".claude", "CLAUDE.md");
  const hermes = path.join(home, ".hermes", "config.yaml");

  if (remove) {
    if (has("claude")) quiet("claude", ["mcp", "remove", "ridealong", "--scope", "user"]);
    if (has("codex")) quiet("codex", ["mcp", "remove", "ridealong"]);
    if (has("gemini")) quiet("gemini", ["mcp", "remove", "--scope", "user", "ridealong"]);
    if (has("agy")) quiet("agy", ["mcp", "remove", "ridealong"]);
    edit(claudeMd, withoutClaudeBlock);
    edit(hermes, withoutHermesServer);
    return;
  }

  if (has("claude")) {
    quiet("claude", ["mcp", "remove", "playwright", "--scope", "user"]);
    quiet("claude", ["mcp", "remove", "ridealong", "--scope", "user"]);
    const r = quiet("claude", ["mcp", "add", "ridealong", "--scope", "user", "--", command, ...agent("Claude")]);
    if (r.status === 0) {
      // Tell future sessions how to use the browser.
      fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
      const text = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, "utf8") : "";
      fs.writeFileSync(claudeMd, withClaudeBlock(text, instructions, url));
      log("Claude Code: registered");
    } else log(`Claude Code: skipped, it failed: ${(r.stderr || r.stdout).trim()}`);
  }

  if (has("codex")) {
    quiet("codex", ["mcp", "remove", "ridealong"]);
    const r = quiet("codex", ["mcp", "add", "ridealong", "--", command, ...agent("Codex")]);
    if (r.status === 0) {
      edit(path.join(home, ".codex", "config.toml"), withCodexSettings);
      log("Codex: registered");
    } else log(`Codex: skipped, it failed: ${(r.stderr || r.stdout).trim()}`);
  }

  // A client that can't start must not stop the ones after it.
  if (has("gemini")) {
    quiet("gemini", ["mcp", "remove", "--scope", "user", "ridealong"]);
    const r = quiet("gemini", ["mcp", "add", "--scope", "user", "ridealong", command, ...agent("Gemini")]);
    log(r.status === 0 ? "Gemini CLI: registered" : "Gemini CLI: skipped, it failed to run. Fix it, then run: ridealong connect");
  }

  // Antigravity CLI, which replaces Gemini CLI.
  if (has("agy")) {
    quiet("agy", ["mcp", "remove", "ridealong"]);
    const r = quiet("agy", ["mcp", "add", "ridealong", command, ...agent("Antigravity")]);
    log(r.status === 0 ? "Antigravity CLI: registered" : "Antigravity CLI: skipped, it failed to run. Fix it, then run: ridealong connect");
  }

  if (fs.existsSync(hermes)) {
    fs.copyFileSync(hermes, hermes + ".bak-ridealong");
    edit(hermes, (yaml) => withHermesServer(yaml, command, agent("Hermes")));
    log("Hermes: registered. Send /reload-mcp in Hermes, or restart its gateway.");
  }
};
