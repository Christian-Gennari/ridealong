// The ridealong command: runs Ridealong in Docker, a real, logged-in Brave for AI
// agents. Works the same on Linux, macOS and Windows; only Docker is required.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./connect.mjs";
import {
  WINDOWS, Fail, die, parseConfig, formatConfig, which, run, attach, launch, sleep,
  lanAddress, resolvePath, timezone,
} from "./lib.mjs";
import { spawn } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = path.join(ROOT, "ridealong");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
// A git clone can build the image itself and update with git; an npm install can't.
const CHECKOUT = fs.existsSync(path.join(ROOT, ".git"));
const CAN_BUILD = fs.existsSync(path.join(ROOT, "Dockerfile"));
const DEFAULT_IMAGE = "ghcr.io/christian-gennari/ridealong:latest";
// Inside the container the shared folder is at the host's path, so the paths
// agents see work on both sides. A Windows path isn't a Linux path, so there it
// gets a fixed one and the MCP wrapper translates.
// RIDEALONG_FILES_INSIDE forces the Windows layout, so it can be tested anywhere.
const filesInside = (files) => process.env.RIDEALONG_FILES_INSIDE || (WINDOWS ? "/ridealong-files" : files);

const USAGE = `Usage: ridealong [--name NAME] <command>

  --name NAME Manage a separate instance with its own container and config
              (default: ridealong, or $RIDEALONG_NAME)

  up        Start Ridealong, downloading it the first time
              --network auto|tailscale|ssh|lan   How you reach the viewer
              --host-network                     Let agents open localhost on this server (Linux)
              --port N                           Viewer port (default 6086)
              --https-port N                     Tailscale port (default 6087)
              --resolution WxH                   Screen size (default 1920x1080)
              --allow-host NAME                  Accept this address, for your own proxy
              --notify URL                       Push here when it's your turn
              --build                            Build from this checkout instead of downloading
              --profile DIR                      Brave profile (default ~/.ridealong-browser)
              --files DIR                        Folder shared with agents (default ~/ridealong-files)
  down      Stop it
  restart   Restart it
  status    Show whether it's healthy and where to find it
  logs      Follow the logs
  update    Get the latest version, including Brave, and restart
  connect   Connect the MCP clients installed here
  mcp       Run the MCP server on stdio (what agents start)
  migrate   Replace an older install that ran directly on this server (Linux)
  uninstall Remove the container and agent config, keeping your profile and files
  version   Print the version
`;

// Everything about one instance: its name, files and where its messages go.
const instance = (name, out) => {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) die(`Bad name: ${name} (use lowercase letters, digits, - and _)`);
  const suffix = name === "ridealong" ? "" : `-${name}`;
  const home = os.homedir();
  const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), `ridealong${suffix}`);
  return {
    name, suffix, home, out, configDir,
    configFile: path.join(configDir, "config.env"),
    // Only a git clone needs this link; npm puts the command on PATH itself.
    link: WINDOWS ? null : path.join(home, ".local", "bin", "ridealong"),
    container: name,
    config: {},
  };
};

const load = (it) => {
  it.config = fs.existsSync(it.configFile) ? parseConfig(fs.readFileSync(it.configFile, "utf8")) : {};
  return it.config;
};

const haveDocker = () => {
  if (!process.env.RIDEALONG_DOCKER && !which("docker")) die("Ridealong needs Docker: https://docs.docker.com/get-started/get-docker/");
  if (run("docker", ["compose", "version"]).status !== 0) die("Ridealong needs Docker Compose: https://docs.docker.com/compose/install/");
  if (run("docker", ["info"], { timeout: 30000 }).status !== 0) {
    die(process.platform === "linux"
      ? `Can't reach Docker. Is it running, and is ${os.userInfo().username} in the docker group?`
      : "Can't reach Docker. Start Docker Desktop, then try again.");
  }
};

const composeArgs = (it, args) => {
  const files = ["-f", path.join(ROOT, "compose.yaml")];
  if (it.config.RIDEALONG_HOST_NETWORK === "1") files.push("-f", path.join(ROOT, "compose.host.yaml"));
  return ["compose", "-p", it.name, "--project-directory", ROOT, "--env-file", it.configFile, ...files, ...args];
};
// Values worked out on each run rather than stored, since they depend on this computer.
const composeEnv = (it) => ({
  RIDEALONG_FILES_INSIDE: filesInside(it.config.RIDEALONG_FILES || ""),
  RIDEALONG_HOST_OS: process.platform,
});
const compose = (it, args, opts = {}) => run("docker", composeArgs(it, args), { env: composeEnv(it), ...opts });
// Compose's progress goes to the terminal, or to stderr when stdout is an MCP client's.
const composeLive = (it, args) => attach("docker", composeArgs(it, args), {
  env: composeEnv(it), stdio: ["ignore", it.out === console.error ? process.stderr : "inherit", "inherit"],
});

const inspect = (it, format) => {
  const r = run("docker", ["inspect", "-f", format, it.container]);
  return r.status === 0 ? r.stdout.trim() : "";
};
const running = (it) => inspect(it, "{{.State.Running}}") === "true";
const insideCurl = (it, url) => {
  const r = run("docker", ["exec", it.container, "curl", "-fsS", "-m", "4", url], { timeout: 10000 });
  return r.status === 0 ? r.stdout : null;
};

const waitHealthy = async (it) => {
  it.out("Waiting for Brave...");
  // Generous, because an emulated image (an ARM Mac without the arm64 image) is slow to start.
  for (let i = 0; i < 180; i += 1) {
    if (inspect(it, "{{.State.Health.Status}}") === "healthy") return;
    if (insideCurl(it, "http://127.0.0.1:9222/json/version")) return;
    await sleep(1000);
  }
  die("Ridealong didn't come up. See: ridealong logs");
};

// Tailscale's command is not on PATH on a Mac with the App Store app.
const tailscaleBin = () => which("tailscale") ||
  ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => fs.existsSync(p)) || null;

const tailnetHost = () => {
  const bin = tailscaleBin();
  if (!bin) return "";
  const r = run(bin, ["status", "--json"], { timeout: 10000 });
  try {
    const d = JSON.parse(r.stdout);
    return d.BackendState === "Running" ? String(d.Self?.DNSName || "").replace(/\.$/, "") : "";
  } catch { return ""; }
};

const writeConfig = (it, values) => {
  fs.mkdirSync(it.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(it.configFile, formatConfig(values), { mode: 0o600 });
  load(it);
};

const serveTailscale = (it) => {
  const c = it.config;
  if (c.RIDEALONG_NETWORK !== "tailscale") return;
  const bin = tailscaleBin();
  if (bin && run(bin, ["serve", "status"], { timeout: 10000 }).stdout.includes(`:${c.RIDEALONG_HTTPS_PORT}`)) return;
  const r = bin ? run(bin, ["serve", "--bg", `--https=${c.RIDEALONG_HTTPS_PORT}`, `http://127.0.0.1:${c.RIDEALONG_PORT}`], { timeout: 20000 }) : { status: 1 };
  if (r.status === 0) {
    // Remembered so uninstall only removes a link this instance made.
    writeConfig(it, { ...c, RIDEALONG_SERVED: "1" });
  } else {
    it.out("Couldn't set up Tailscale's HTTPS link. Turn on HTTPS at https://login.tailscale.com/admin/dns, then run:");
    it.out(`  ${WINDOWS ? "" : "sudo "}tailscale serve --bg --https=${c.RIDEALONG_HTTPS_PORT} http://127.0.0.1:${c.RIDEALONG_PORT}`);
  }
};

const version = () => {
  if (CHECKOUT) {
    const r = run("git", ["-C", ROOT, "describe", "--always", "--dirty"]);
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return PKG.version;
};

// How an MCP client starts this command. A stable path, so a client keeps working
// after an update: the ~/.local/bin link of a clone, npm's own link, or else Node
// and this file. Windows can't start npm's .cmd link without a shell, so it always
// gets Node and this file.
export const mcpCommand = (it) => {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const me = real(LAUNCHER);
  if (!WINDOWS) {
    if (it.link && real(it.link) === me) return { command: it.link, prefix: [] };
    const onPath = which("ridealong");
    if (onPath && real(onPath) === me) return { command: onPath, prefix: [] };
  }
  return { command: process.execPath, prefix: [LAUNCHER] };
};

const takeValue = (args, i, flag) => {
  if (i + 1 >= args.length) die(`${flag} needs a value`);
  return args[i + 1];
};

const up = async (it, args, { refresh = false } = {}) => {
  const c = load(it);
  const firstRun = !fs.existsSync(it.configFile);
  const s = {
    network: c.RIDEALONG_NETWORK || "auto",
    hostNetwork: c.RIDEALONG_HOST_NETWORK || "0",
    port: c.RIDEALONG_PORT || "6086",
    httpsPort: c.RIDEALONG_HTTPS_PORT || "6087",
    resolution: c.RIDEALONG_RESOLUTION || "1920x1080",
    allowedHosts: c.RIDEALONG_ALLOWED_HOSTS || "",
    notify: c.RIDEALONG_NOTIFY_URL || "",
    profile: c.RIDEALONG_PROFILE || path.join(it.home, `.ridealong-browser${it.suffix}`),
    files: c.RIDEALONG_FILES || path.join(it.home, `ridealong-files${it.suffix}`),
    token: c.RIDEALONG_TOKEN || "",
    image: c.RIDEALONG_IMAGE || "",
  };
  let build = false;
  // A named instance gets its own image tag, so building it never retags the
  // image the real install runs. Without the sources it uses the published image.
  if (it.suffix && CAN_BUILD) { s.image = `ridealong-dev:${it.name}`; build = true; }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const v = () => takeValue(args, i++, a);
    switch (a) {
      case "--network": s.network = v(); break;
      case "--host-network": s.hostNetwork = "1"; break;
      case "--port": s.port = v(); break;
      case "--https-port": s.httpsPort = v(); break;
      case "--resolution": s.resolution = v(); break;
      case "--allow-host": s.allowedHosts = s.allowedHosts ? `${s.allowedHosts},${v()}` : v(); break;
      case "--notify": s.notify = v(); break;
      case "--build": build = true; break;
      case "--profile": s.profile = resolvePath(v()); break;
      case "--files": s.files = resolvePath(v()); break;
      default: die(`Unknown option: ${a}`);
    }
  }
  for (const [flag, value] of [["--port", s.port], ["--https-port", s.httpsPort]]) {
    if (!/^\d+$/.test(value) || +value < 1 || +value > 65535) die(`${flag} needs a port number, not ${value}`);
  }
  if (!/^\d+x\d+$/.test(s.resolution)) die(`--resolution needs WIDTHxHEIGHT, not ${s.resolution}`);
  if (build && !CAN_BUILD) die("--build needs the source. Clone https://github.com/Christian-Gennari/ridealong and run it from there.");
  // Docker Desktop runs containers in a VM, so its host network is the VM's.
  if (s.hostNetwork === "1" && process.platform !== "linux") {
    die("--host-network only works on Linux. With Docker Desktop, agents reach this computer at host.docker.internal, for example http://host.docker.internal:3000.");
  }
  haveDocker();

  // The viewer stays on loopback unless --network lan asks otherwise; Tailscale
  // or an SSH tunnel reaches it there.
  let bind = "127.0.0.1";
  let url;
  if (s.network === "auto" || s.network === "tailscale") {
    const tailnet = tailnetHost();
    if (s.network === "tailscale" && !tailnet) die("Tailscale isn't connected. Run 'tailscale up', or use --network ssh.");
    s.network = tailnet ? "tailscale" : "ssh";
    if (tailnet) url = `https://${tailnet}:${s.httpsPort}/`;
  }
  if (s.network === "ssh") url = `http://127.0.0.1:${s.port}/`;
  else if (s.network === "lan") {
    if (s.hostNetwork === "1") die("--network lan doesn't work with --host-network.");
    bind = "0.0.0.0";
    s.token ||= crypto.randomBytes(24).toString("hex");
    url = `http://${lanAddress()}:${s.port}/?token=${s.token}`;
  } else if (s.network !== "tailscale") die(`Unknown network: ${s.network} (use tailscale, ssh or lan)`);
  if (s.network !== "lan") s.token = "";
  // The default instance owns these ports; a named one must not share them.
  if (it.suffix) {
    if (s.port === "6086") die(`Instance ${it.name} needs its own viewer port. Add --port N (not 6086).`);
    if (s.network === "tailscale" && s.httpsPort === "6087") die(`Instance ${it.name} needs its own Tailscale port. Add --https-port N (not 6087).`);
  }

  // Created here so they belong to you, not to Docker.
  for (const dir of [s.profile, s.files]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!WINDOWS) fs.chmodSync(dir, 0o700);
  }
  const now = String(Math.floor(Date.now() / 1000));
  writeConfig(it, {
    RIDEALONG_NETWORK: s.network,
    RIDEALONG_HOST_NETWORK: s.hostNetwork,
    RIDEALONG_URL: url,
    RIDEALONG_TOKEN: s.token,
    RIDEALONG_BIND: bind,
    RIDEALONG_PORT: s.port,
    RIDEALONG_HTTPS_PORT: s.httpsPort,
    RIDEALONG_SERVED: c.RIDEALONG_SERVED || "0",
    RIDEALONG_RESOLUTION: s.resolution,
    RIDEALONG_ALLOWED_HOSTS: s.allowedHosts,
    RIDEALONG_NOTIFY_URL: s.notify,
    RIDEALONG_PROFILE: s.profile,
    RIDEALONG_FILES: s.files,
    RIDEALONG_IDLE_HIDE_MIN: c.RIDEALONG_IDLE_HIDE_MIN || "15",
    RIDEALONG_IDLE_RELEASE_MIN: c.RIDEALONG_IDLE_RELEASE_MIN || "120",
    RIDEALONG_NAME: it.name,
    RIDEALONG_IMAGE: s.image,
    // Docker Desktop maps file owners itself, so the ids only matter on Linux.
    RIDEALONG_UID: String(process.getuid ? process.getuid() : 1000),
    RIDEALONG_GID: String(process.getgid ? process.getgid() : 1000),
    RIDEALONG_TZ: timezone(),
    RIDEALONG_VERSION: version(),
    RIDEALONG_BUILT: refresh || !c.RIDEALONG_BUILT ? now : c.RIDEALONG_BUILT,
    RIDEALONG_REFRESH: refresh || !c.RIDEALONG_REFRESH ? now : c.RIDEALONG_REFRESH,
  });

  // A published image is much quicker than building one. Build if there isn't one.
  let code;
  if (build) code = await composeLive(it, ["up", "-d", "--build"]);
  else {
    const pulled = compose(it, ["pull", "--quiet"]);
    if (pulled.status === 0) code = await composeLive(it, ["up", "-d"]);
    else if (CAN_BUILD) code = await composeLive(it, ["up", "-d", "--build"]);
    else die(`Couldn't download ${s.image || DEFAULT_IMAGE}:\n${pulled.stderr.trim()}`);
  }
  if (code !== 0) die("Docker couldn't start Ridealong. See the messages above.");
  await waitHealthy(it);
  serveTailscale(it);

  // Only the real install owns the command link and the agents' MCP entries.
  if (!it.suffix) {
    let linked = false;
    if (CHECKOUT && it.link && !fs.existsSync(it.link)) {
      fs.mkdirSync(path.dirname(it.link), { recursive: true });
      try { fs.unlinkSync(it.link); } catch { /* a dangling link */ }
      fs.symlinkSync(LAUNCHER, it.link);
      linked = true;
    }
    if (linked || firstRun) connectAgents(it);
  }

  const say = it.out;
  say("");
  say("Ridealong is ready.");
  say("");
  say(`  Viewer:  ${url}`);
  if (s.network === "ssh") {
    say("  This viewer is private to this computer. From another computer run:");
    say(`    ssh -L ${s.port}:127.0.0.1:${s.port} ${os.userInfo().username}@${os.hostname()}`);
    say("  Then open the link above. Tailscale gives you an always-on link from any device.");
  } else if (s.network === "lan") {
    say("  Anyone on this network with that link controls a logged-in browser. Keep it secret.");
  }
  say("");
  say("  Next: in the viewer choose Control, sign into your accounts in Brave, then go back to Auto.");
};

const status = (it) => {
  load(it);
  haveDocker();
  if (!running(it)) return console.log("Ridealong is stopped. Start it with: ridealong up");
  const port = it.config.RIDEALONG_HOST_NETWORK === "1" ? it.config.RIDEALONG_PORT || "6086" : "6086";
  const health = insideCurl(it, `http://127.0.0.1:${port}/api/health`);
  let brave = "NOT ANSWERING";
  try { brave = JSON.parse(insideCurl(it, "http://127.0.0.1:9222/json/version")).Browser; } catch { /* stays */ }
  console.log(`Container:  ${inspect(it, "{{.State.Status}}, {{.State.Health.Status}}")}`);
  console.log(`Viewer:     ${it.config.RIDEALONG_URL || "unknown"}`);
  console.log(`Brave:      ${brave}`);
  console.log(`Ridealong:  ${health ? health.trim() : "viewer NOT ANSWERING"}`);
};

const update = async (it) => {
  load(it);
  haveDocker();
  if (CHECKOUT) {
    if (run("git", ["-C", ROOT, "pull", "--ff-only"], { inherit: "inherit" }).status !== 0) die("git pull failed. See above.");
  } else {
    const latest = run("npm", ["view", PKG.name, "version"], { timeout: 15000 }).stdout.trim();
    if (latest && latest !== PKG.version) {
      it.out(`ridealong ${latest} is out (you have ${PKG.version}). Get it with: npm install -g ${PKG.name}`);
    }
  }
  await up(it, [], { refresh: true });
};

const connectAgents = (it, remove = false) => {
  const { command, prefix } = mcpCommand(it);
  // npx runs from a cache that npm may clear, and the agents would lose the command.
  if (!remove && /[\\/]_npx[\\/]/.test(ROOT)) {
    it.out(`Agents would start ridealong from npx's cache, which npm can clear. Install it for good: npm install -g ${PKG.name}, then run: ridealong connect`);
  }
  connect({
    home: it.home,
    url: it.config.RIDEALONG_URL || "the viewer",
    command, prefix, remove, log: it.out,
    instructions: fs.readFileSync(path.join(ROOT, "docs", "agent-instructions.md"), "utf8"),
  });
};

// Stdin and stdout belong to the MCP client here, so anything else goes to stderr.
const mcp = async (it, args) => {
  load(it);
  haveDocker();
  if (!running(it)) await up(it, []);
  const env = process.env.RIDEALONG_ELICITATION ? ["-e", "RIDEALONG_ELICITATION"] : [];
  const [file, argv, extra] = launch("docker", ["exec", "-i", ...env, it.container, "ridealong-mcp", ...args]);
  const child = spawn(file, argv, { ...extra, stdio: "inherit" });
  // The client ends us with a signal; pass it on, so the session closes its tab.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* gone */ } });
  }
  child.on("error", (e) => { console.error(e.message); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
};

const migrate = async (it, args) => {
  if (process.platform !== "linux" || !fs.existsSync("/opt/ridealong")) die("There's no older install in /opt/ridealong.");
  haveDocker();
  it.out("Removing the old install. Your Brave profile stays where it is.");
  if (run("sudo", [path.join(ROOT, "scripts", "remove-host-install")], { inherit: "inherit" }).status !== 0) die("Removing the old install failed.");
  if (it.link) fs.rmSync(it.link, { force: true });
  await up(it, args);
};

const uninstall = (it) => {
  const c = load(it);
  haveDocker();
  if (!fs.existsSync(it.configFile)) die("Ridealong isn't set up here.");
  if (!it.suffix) connectAgents(it, true);
  // A named instance only removes a Tailscale link it created itself.
  if (c.RIDEALONG_NETWORK === "tailscale" && (!it.suffix || c.RIDEALONG_SERVED === "1")) {
    const bin = tailscaleBin();
    if (bin) run(bin, ["serve", `--https=${c.RIDEALONG_HTTPS_PORT || "6087"}`, "off"], { timeout: 20000 });
  }
  // A named instance's image is its own (ridealong-dev:NAME), so --rmi all is safe.
  compose(it, ["down", "--rmi", "all"], { inherit: "inherit" });
  if (!it.suffix && it.link) {
    try { if (fs.realpathSync(it.link) === fs.realpathSync(LAUNCHER)) fs.unlinkSync(it.link); } catch { /* not ours */ }
  }
  fs.rmSync(it.configFile, { force: true });
  try { fs.rmdirSync(it.configDir); } catch { /* not empty */ }
  console.log(`Removed. Your Brave profile and shared files are still in ${c.RIDEALONG_PROFILE} and ${c.RIDEALONG_FILES}.`);
};

export const main = async (argv) => {
  let args = [...argv];
  let name = process.env.RIDEALONG_NAME || "ridealong";
  if (args[0] === "--name") {
    if (args.length < 2) { console.error("--name needs a value"); return 2; }
    name = args[1];
    args = args.slice(2);
  }
  const command = args.shift() || "help";
  // The MCP client reads stdout, so `mcp` must keep it clean.
  const it = instance(name, command === "mcp" ? console.error : console.log);
  process.env.RIDEALONG_NAME = name;
  const plain = async (fn) => { load(it); haveDocker(); return fn(); };
  switch (command) {
    case "up": await up(it, args); return 0;
    case "down": return plain(() => composeLive(it, ["down"]));
    case "restart": return plain(async () => { const code = await composeLive(it, ["restart"]); if (!code) await waitHealthy(it); return code; });
    case "status": status(it); return 0;
    case "logs": return plain(() => composeLive(it, ["logs", "-f", "--tail", "100"]));
    case "update": await update(it); return 0;
    case "connect":
      if (it.suffix) die(`Agents connect to the default instance only. For ${name}, run: RIDEALONG_NAME=${name} ridealong mcp`);
      load(it);
      connectAgents(it, args[0] === "--remove");
      return 0;
    case "mcp": await mcp(it, args); return null;
    case "migrate": await migrate(it, args); return 0;
    case "uninstall": uninstall(it); return 0;
    case "version": case "--version": case "-v": console.log(version()); return 0;
    case "help": case "-h": case "--help": process.stdout.write(USAGE); return 0;
    default: process.stderr.write(USAGE); return 2;
  }
};

export const cli = (argv) => main(argv).then(
  (code) => { if (code !== null) process.exitCode = code; },
  (e) => {
    if (!(e instanceof Fail)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  },
);
