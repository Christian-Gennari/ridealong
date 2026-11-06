// The ridealong command, end to end, with Docker and the agent CLIs faked. Runs on
// Linux, macOS and Windows.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig, formatConfig, which, lanAddress, resolvePath } from "../lib.mjs";
import { withClaudeBlock, withoutClaudeBlock, withCodexSettings, withHermesServer, withoutHermesServer } from "../connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(HERE, "..", "..", "ridealong");
const WINDOWS = process.platform === "win32";

// A throwaway home (with a space in it, as on many Windows machines), fake Docker,
// and fake claude, codex and agy on PATH.
const sandbox = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ridealong cli "));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const log = path.join(root, "log.jsonl");
  for (const name of ["claude", "codex", "agy"]) {
    const fake = path.join(HERE, "fake-client.mjs");
    if (WINDOWS) {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nset FAKE_NAME=${name}\r\n"${process.execPath}" "${fake}" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nFAKE_NAME=${name} exec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    }
  }
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: "",
    PATH: bin, Path: undefined,
    RIDEALONG_DOCKER: path.join(HERE, "fake-docker.mjs"),
    RIDEALONG_NAME: "",
    FAKE_LOG: log,
    FAKE_STATE: path.join(root, "running"),
  };
  delete env.Path;
  delete env.XDG_CONFIG_HOME;
  delete env.RIDEALONG_NAME;
  const ridealong = (args, extra = {}) => spawnSync(process.execPath, [LAUNCHER, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const config = (name = "ridealong") => parseConfig(fs.readFileSync(path.join(home, ".config", name, "config.env"), "utf8"));
  return { root, home, env, ridealong, calls, config, log };
};

test("config.env reads the old bash format and keeps Windows paths intact", () => {
  const old = 'RIDEALONG_NETWORK=tailscale\nRIDEALONG_URL="https://box.ts.net:6087/"\nRIDEALONG_NOTIFY_URL=""\nRIDEALONG_ALLOWED_HOSTS=\n';
  assert.deepEqual(parseConfig(old), {
    RIDEALONG_NETWORK: "tailscale", RIDEALONG_URL: "https://box.ts.net:6087/", RIDEALONG_NOTIFY_URL: "", RIDEALONG_ALLOWED_HOSTS: "",
  });
  const values = { A: "C:\\Users\\Me Too\\ridealong-files", B: "https://x.test/?token=ab", C: "", D: "plain" };
  assert.deepEqual(parseConfig(formatConfig(values)), values);
  assert.match(formatConfig(values), /^A='C:\\Users\\Me Too\\ridealong-files'$/m);
  assert.throws(() => formatConfig({ A: "it's" }), /can't contain a quote/);
});

test("CLAUDE.md gets one block, replaced on re-runs and removed cleanly", () => {
  const once = withClaudeBlock("# Mine\n", "Use @VIEWER_URL@.", "https://v/");
  assert.equal(once, "# Mine\n\n<!-- ridealong -->\nUse https://v/.\n<!-- /ridealong -->\n");
  assert.equal(withClaudeBlock(once, "New @VIEWER_URL@.", "https://w/"), "# Mine\n\n<!-- ridealong -->\nNew https://w/.\n<!-- /ridealong -->\n");
  assert.equal(withClaudeBlock("", "x", "u"), "<!-- ridealong -->\nx\n<!-- /ridealong -->\n");
  assert.equal(withoutClaudeBlock(once).trim(), "# Mine");
  assert.equal(withClaudeBlock("<!-- agent-browser -->\nold\n<!-- /agent-browser -->\n", "x", "u"), "<!-- ridealong -->\nx\n<!-- /ridealong -->\n");
});

test("Codex gets the long timeout and approve mode once", () => {
  const toml = '[mcp_servers.ridealong]\ncommand = "ridealong"\n\n[other]\nx = 1\n';
  const once = withCodexSettings(toml);
  assert.equal(once, '[mcp_servers.ridealong]\ntool_timeout_sec = 660\ndefault_tools_approval_mode = "approve"\ncommand = "ridealong"\n\n[other]\nx = 1\n');
  assert.equal(withCodexSettings(once), once);
  assert.equal(withCodexSettings("[other]\n"), "[other]\n");
});

test("Hermes gets one server entry, quoted where YAML needs it", () => {
  const yaml = "model: x\nmcp_servers:\n  playwright:\n    command: npx\n  other:\n    command: y\n";
  const out = withHermesServer(yaml, "C:\\Program Files\\nodejs\\node.exe", ["C:\\r\\ridealong", "mcp", "--agent", "Hermes"]);
  assert.equal(out, "model: x\nmcp_servers:\n  ridealong:\n    command: 'C:\\Program Files\\nodejs\\node.exe'\n    args:\n" +
    "      - 'C:\\r\\ridealong'\n      - mcp\n      - --agent\n      - Hermes\n    timeout: 660\n  other:\n    command: y\n");
  assert.equal(withoutHermesServer(out), "model: x\nmcp_servers:\n  other:\n    command: y\n");
  assert.match(withHermesServer("model: x\n", "/bin/r", ["mcp"]), /^model: x\nmcp_servers:\n {2}ridealong:\n/);
});

test("helpers: which, LAN address, ~ paths", () => {
  const { root } = sandbox();
  assert.equal(which("claude", { PATH: path.join(root, "bin"), PATHEXT: ".CMD" }).toLowerCase(), path.join(root, "bin", WINDOWS ? "claude.cmd" : "claude").toLowerCase());
  assert.equal(which("nope", { PATH: path.join(root, "bin") }), null);
  assert.equal(lanAddress({
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
    eth0: [{ family: "IPv6", address: "fe80::1", internal: false }, { family: "IPv4", address: "192.168.1.5", internal: false }],
  }), "192.168.1.5");
  assert.equal(resolvePath("~/x", "/home/me"), path.resolve("/home/me/x"));
});

test("up starts it, writes the config, links agents once, and mcp passes stdio through", async () => {
  const s = sandbox();
  const files = path.join(s.root, "my files");
  const r = s.ridealong(["up", "--network", "ssh", "--port", "16999", "--files", files]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Ridealong is ready\.\n\n {2}Viewer: {2}http:\/\/127\.0\.0\.1:16999\//);
  assert.match(r.stdout, /Claude Code: registered\nCodex: registered\nAntigravity CLI: registered/);

  const c = s.config();
  assert.equal(c.RIDEALONG_FILES, files);
  assert.equal(c.RIDEALONG_PORT, "16999");
  assert.equal(c.RIDEALONG_NETWORK, "ssh");
  assert.ok(fs.statSync(files).isDirectory());
  assert.ok(fs.existsSync(path.join(s.home, ".ridealong-browser")));

  const calls = s.calls();
  const up = calls.find((x) => x.args?.includes("up"));
  assert.ok(up.args.includes("--env-file"));
  assert.ok(!up.args.includes("--build"), "a published image is pulled, not built");
  assert.equal(up.filesInside, WINDOWS ? "/ridealong-files" : files);
  assert.equal(up.hostOs, process.platform);
  // Agents start this very file, by a path that survives updates.
  const claude = calls.find((x) => x.client === "claude" && x.args[1] === "add");
  const tail = claude.args.slice(claude.args.indexOf("--") + 1);
  assert.deepEqual(tail.slice(-3), ["mcp", "--agent", "Claude"]);
  assert.equal(fs.realpathSync(tail.length === 5 ? tail[1] : tail[0]), fs.realpathSync(LAUNCHER));
  assert.match(fs.readFileSync(path.join(s.home, ".claude", "CLAUDE.md"), "utf8"), /http:\/\/127\.0\.0\.1:16999\//);

  // A second up keeps the settings and doesn't register the agents again.
  const again = s.ridealong(["up"]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /registered/);
  assert.equal(s.config().RIDEALONG_PORT, "16999");

  // mcp: stdout is the client's, so it carries only what the server says.
  const child = spawn(process.execPath, [LAUNCHER, "mcp", "--agent", "Test"], { env: s.env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  assert.equal(out, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const exec = s.calls().find((x) => x.args?.[0] === "exec" && x.args[1] === "-i");
  assert.deepEqual(exec.args, ["exec", "-i", "ridealong", "ridealong-mcp", "--agent", "Test"]);

  const status = s.ridealong(["status"]);
  assert.match(status.stdout, /Brave: {6}Brave\/1/);

  const gone = s.ridealong(["uninstall"]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!fs.existsSync(path.join(s.home, ".config", "ridealong", "config.env")));
  assert.doesNotMatch(fs.readFileSync(path.join(s.home, ".claude", "CLAUDE.md"), "utf8"), /ridealong/);
});

test("mcp starts a stopped Ridealong, with its messages on stderr", async () => {
  const s = sandbox();
  assert.equal(s.ridealong(["up", "--network", "ssh"]).status, 0);
  s.ridealong(["down"]);
  const child = spawn(process.execPath, [LAUNCHER, "mcp"], { env: s.env });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.stdin.end("hello\n");
  assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0);
  assert.equal(out, "hello\n");
  assert.match(err, /Ridealong is ready/);
});

test("a named instance keeps apart and refuses the default ports", () => {
  const s = sandbox();
  const bad = s.ridealong(["--name", "dev", "up", "--network", "ssh"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /needs its own viewer port/);
  const ok = s.ridealong(["--name", "dev", "up", "--network", "ssh", "--port", "16998"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout, /registered/, "only the default instance connects agents");
  assert.equal(s.config("ridealong-dev").RIDEALONG_IMAGE, "ridealong-dev:dev");
  assert.ok(s.calls().some((x) => x.args?.includes("--build")), "a named instance builds from the checkout");
  assert.match(s.ridealong(["--name", "dev", "connect"]).stderr, /default instance only/);
});

test("bad input fails clearly, before touching Docker", () => {
  const s = sandbox();
  assert.match(s.ridealong(["up", "--port", "x"]).stderr, /--port needs a port number/);
  assert.match(s.ridealong(["up", "--resolution", "big"]).stderr, /WIDTHxHEIGHT/);
  assert.match(s.ridealong(["up", "--bogus"]).stderr, /Unknown option: --bogus/);
  assert.match(s.ridealong(["up", "--network"]).stderr, /--network needs a value/);
  assert.match(s.ridealong(["--name", "Bad!", "status"]).stderr, /Bad name/);
  assert.equal(s.ridealong(["nope"]).status, 2);
  if (process.platform !== "linux") assert.match(s.ridealong(["up", "--host-network"]).stderr, /only works on Linux/);
  assert.deepEqual(s.calls(), []);
});

test("lan gets a token link and keeps the token", () => {
  const s = sandbox();
  const r = s.ridealong(["up", "--network", "lan", "--port", "16997"]);
  assert.equal(r.status, 0, r.stderr);
  const c = s.config();
  assert.equal(c.RIDEALONG_BIND, "0.0.0.0");
  assert.match(c.RIDEALONG_TOKEN, /^[0-9a-f]{48}$/);
  assert.match(c.RIDEALONG_URL, new RegExp(`:16997/\\?token=${c.RIDEALONG_TOKEN}$`));
  s.ridealong(["up"]);
  assert.equal(s.config().RIDEALONG_TOKEN, c.RIDEALONG_TOKEN);
});
