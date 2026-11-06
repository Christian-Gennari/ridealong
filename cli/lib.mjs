// Small helpers the CLI shares. No dependencies, and nothing newer than Node 18,
// because some agents start `ridealong mcp` with whatever Node is first on PATH.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WINDOWS = process.platform === "win32";

export class Fail extends Error {}
export const die = (message) => { throw new Fail(message); };

// config.env is both our settings file and Docker Compose's --env-file, so it uses
// the subset of the format both read the same way: KEY=value, KEY='value', KEY="value".
export const parseConfig = (text) => {
  const config = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) value = value.slice(1, -1);
    else if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
    config[m[1]] = value;
  }
  return config;
};

// Single quotes are literal in Compose, which keeps a Windows path's backslashes.
// Compose can't escape a single quote inside them, so such a value is refused.
export const formatConfig = (entries) => Object.entries(entries).map(([key, raw]) => {
  const value = String(raw ?? "");
  if (/^[A-Za-z0-9_./:@,+-]*$/.test(value)) return `${key}=${value}`;
  if (value.includes("'") || /[\r\n]/.test(value)) die(`${key} can't contain a quote or a line break: ${value}`);
  return `${key}='${value}'`;
}).join("\n") + "\n";

// Where `command` would run from, or null. Honours PATHEXT on Windows.
export const which = (command, env = process.env) => {
  const exts = WINDOWS ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          if (!WINDOWS) fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch { /* not here */ }
    }
  }
  return null;
};

// cmd.exe quoting, for the .cmd shims npm installs on Windows (Node won't start
// those without a shell). Only used on Windows.
const cmdQuote = (arg) => {
  if (arg && !/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
};

// How to start `command` with `args`, without any shell on Linux and macOS.
export const launch = (command, args) => {
  // Tests stand in for Docker with a Node script.
  if (command === "docker" && process.env.RIDEALONG_DOCKER) return [process.execPath, [process.env.RIDEALONG_DOCKER, ...args], {}];
  if (WINDOWS) {
    const found = which(command);
    if (found && /\.(cmd|bat)$/i.test(found)) {
      const line = [found, ...args].map(cmdQuote).join(" ");
      return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true }];
    }
    if (found) return [found, args, {}];
  }
  return [command, args, {}];
};

// Runs to the end and returns { status, stdout, stderr }. A missing program is status 127.
export const run = (command, args, { input, timeout, env, inherit } = {}) => {
  const [file, argv, extra] = launch(command, args);
  const r = spawnSync(file, argv, {
    ...extra, input, timeout, env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8", stdio: inherit ? ["ignore", inherit, "inherit"] : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (r.error && r.error.code === "ENOENT") return { status: 127, stdout: "", stderr: `${command}: not found` };
  return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
};

// Runs with the terminal attached and resolves to the exit code.
export const attach = (command, args, { stdio = "inherit", env } = {}) => new Promise((resolve) => {
  const [file, argv, extra] = launch(command, args);
  const child = spawn(file, argv, { ...extra, stdio, env: env ? { ...process.env, ...env } : process.env });
  child.on("error", (e) => { console.error(e.message); resolve(127); });
  child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The first address other machines on the LAN can use, skipping Docker's and VPN bridges.
export const lanAddress = (interfaces = os.networkInterfaces()) => {
  const skip = /^(docker|br-|veth|virbr|tailscale|utun|lo|vEthernet|wsl)/i;
  const all = Object.entries(interfaces).filter(([name]) => !skip.test(name))
    .flatMap(([, list]) => list ?? []).filter((a) => (a.family === "IPv4" || a.family === 4) && !a.internal);
  return all[0]?.address ?? "127.0.0.1";
};

// `ridealong up --files ~/x` on any OS: expand ~ and make it absolute.
export const resolvePath = (p, home = os.homedir()) => path.resolve(p.replace(/^~(?=$|[\\/])/, home));

export const timezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};
