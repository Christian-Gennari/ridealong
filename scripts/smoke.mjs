#!/usr/bin/env node
// Boots the real image in a throwaway home and checks what matters most: the
// sandbox, the viewer, an agent session through `ridealong mcp`, files in the
// shared folder and a server on the host. Runs wherever Docker runs Linux containers.
//   node scripts/smoke.mjs        (SMOKE_PORT=16080, SMOKE_PULL=1 to use the published image,
//                                  RIDEALONG_FILES_INSIDE=/ridealong-files for the Windows layout)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = path.join(ROOT, "ridealong");
const PORT = process.env.SMOKE_PORT || "16080";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ridealong smoke "));
const files = path.join(home, "shared files");
// Its own name, so it never touches a Ridealong that is already running here.
const NAME = `ridealong-smoke-${process.pid}`;
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home,
  // Docker keeps its login and contexts in the real home.
  DOCKER_CONFIG: process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker"),
  RIDEALONG_NAME: NAME,
};
delete env.XDG_CONFIG_HOME;

const ridealong = (args, opts = {}) => spawnSync(process.execPath, [LAUNCHER, ...args], { env, encoding: "utf8", ...opts });
const step = (what) => console.log(`\n== ${what}`);

const mcpSession = () => {
  const child = spawn(process.execPath, [LAUNCHER, "mcp", "--agent", "Smoke"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const request = (method, params, ms = 60000) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, resolve);
    send({ id: n, method, params });
    setTimeout(() => reject(new Error(`${method} got no answer in ${ms} ms`)), ms).unref();
  });
  const call = async (name, args = {}) => {
    const r = await request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return r.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  };
  return { request, send, call, end: () => new Promise((r) => { child.on("exit", r); child.stdin.end(); }) };
};

let failed = false;
try {
  step("up");
  const up = ridealong(["up", ...(process.env.SMOKE_PULL ? [] : ["--build"]), "--network", "ssh", "--port", PORT, "--files", files], { stdio: "inherit" });
  assert.equal(up.status, 0, "ridealong up failed");

  step("sandbox");
  const sandbox = spawnSync("docker", ["exec", NAME, "sh", "-c", `
    renderer=$(pgrep -f -- --type=renderer | head -1)
    [ -n "$renderer" ] || { echo "no renderer"; exit 1; }
    grep -q "^Seccomp:[[:space:]]*2" "/proc/$renderer/status" || { echo "renderer has no seccomp filter"; exit 1; }
    grep -q "^NoNewPrivs:[[:space:]]*1" "/proc/$renderer/status" || { echo "renderer can gain privileges"; exit 1; }
    [ "$(readlink "/proc/$renderer/ns/pid")" != "$(readlink /proc/1/ns/pid)" ] || { echo "renderer is not sandboxed"; exit 1; }
    ! touch /app/x 2>/dev/null || { echo "filesystem is writable"; exit 1; }
  `], { encoding: "utf8" });
  assert.equal(sandbox.status, 0, `sandbox: ${sandbox.stdout}${sandbox.stderr}`);

  step("viewer");
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 200);
  const exposed = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  // Another Ridealong on the host network (or an older one installed directly on
  // the server) legitimately holds 9222 here.
  const others = spawnSync("docker", ["ps", "--filter", "label=com.docker.compose.service=ridealong", "--format", "{{.Names}}"], { encoding: "utf8" })
    .stdout.split("\n").filter((n) => n && n !== NAME);
  const hostNetwork = others.some((n) => spawnSync("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", n], { encoding: "utf8" }).stdout.trim() === "host");
  if (exposed && !hostNetwork && !fs.existsSync("/opt/ridealong")) throw new Error("Brave's debugging port is exposed");

  step("status");
  const status = ridealong(["status"]);
  assert.match(status.stdout, /Brave: +\S+\/\d/, status.stdout);

  step("agent session");
  const mcp = mcpSession();
  const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  mcp.send({ method: "notifications/initialized" });
  assert.ok(init.result.instructions.includes(`shares only ${files} with you`), "the instructions name the host's folder");
  const tools = await mcp.request("tools/list", {});
  assert.ok(tools.result.tools.some((t) => t.name === "browser_handover"), "no browser_handover tool");

  // A page served by this computer, through host.docker.internal.
  const server = http.createServer((req, res) => res.end("<title>smoke</title><h1>hello from the host</h1>"));
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  const page = await mcp.call("browser_navigate", { url: `http://host.docker.internal:${server.address().port}/` });
  server.close();
  assert.match(page, /Page Title: smoke/, `host.docker.internal: ${page}`);

  // Files land in the shared folder, under the path the agent knows.
  const shot = path.join(files, "smoke.png");
  const saved = await mcp.call("browser_take_screenshot", { filename: shot });
  assert.ok(saved.includes(shot), `screenshot answer names ${shot}: ${saved}`);
  assert.ok(fs.statSync(shot).size > 1000, "the screenshot is in the shared folder");
  const relative = await mcp.call("browser_take_screenshot", { filename: "relative.png" });
  assert.ok(relative.includes(path.join(files, "relative.png")), `relative screenshot: ${relative}`);
  assert.ok(fs.existsSync(path.join(files, "relative.png")));
  await mcp.end();

  console.log("\nSmoke test passed.");
} catch (e) {
  failed = true;
  console.error(`\nSmoke test FAILED: ${e.message}`);
  spawnSync("docker", ["logs", "--tail", "60", NAME], { stdio: "inherit" });
} finally {
  ridealong(["uninstall"], { stdio: "ignore" });
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
