// Runs inside the container: starts the display, the window manager, VNC, the
// viewer and Brave, and brings back whatever stops. Docker restarts the whole
// container if this ever exits.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = "/profile";
const FILES = process.env.RIDEALONG_FILES;
const RESOLUTION = process.env.RIDEALONG_RESOLUTION || "1920x1080";
const SOCKET = "/tmp/.X11-unix/X99";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const editJson = (file, change) => {
  // Never block Brave over this; the worst case is a notice.
  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    change(data);
    fs.writeFileSync(`${file}.ridealong-tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.ridealong-tmp`, file);
  } catch (e) {
    console.error(`supervise: ${file}: ${e.message}`);
  }
};

const prepareProfile = () => {
  // Any lock is stale: nothing else can be running Brave on this profile.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(PROFILE, f), { force: true });
  fs.mkdirSync(path.join(PROFILE, "Default"), { recursive: true });
  editJson(path.join(PROFILE, "Default/Preferences"), (prefs) => {
    prefs.profile = { ...prefs.profile, exit_type: "Normal", exited_cleanly: true };
    // Always start on a new tab. Restored agent tabs would have no owner.
    prefs.session = { ...prefs.session, restore_on_startup: 5 };
    prefs.download = { ...prefs.download, default_directory: FILES, prompt_for_download: false };
    // Brave saves every session's tab group, and they'd pile up on the bookmarks bar.
    prefs.bookmark_bar = { ...prefs.bookmark_bar, show_tab_groups: false };
  });
  editJson(path.join(PROFILE, "Local State"), (state) => {
    state.brave = { ...state.brave, dont_ask_for_crash_reporting: true };
    state.brave.p3a = { ...state.brave.p3a, enabled: false, notice_acknowledged: true };
  });
};

// Playwright leaves a snapshot and a log for every step. Yours stay; its don't.
const pruneFiles = () => {
  const cutoff = Date.now() - 7 * 86400000;
  for (const name of fs.readdirSync(FILES)) {
    if (!/^(page|console|network)-\d{4}-.*\.(png|jpe?g|yml|log|md)$/.test(name)) continue;
    const file = path.join(FILES, name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file); } catch { /* already gone */ }
  }
};

const waitForDisplay = async () => {
  while (!fs.existsSync(SOCKET)) await sleep(100);
};

const SERVICES = [
  { name: "display", cmd: "Xvfb", args: [":99", "-screen", "0", `${RESOLUTION}x24`, "-nolisten", "tcp", "-noreset"],
    before: () => { fs.rmSync("/tmp/.X99-lock", { force: true }); fs.rmSync(SOCKET, { force: true }); } },
  { name: "windows", display: true, cmd: "matchbox-window-manager", args: ["-use_titlebar", "no"] },
  { name: "vnc", display: true, cmd: "x11vnc", args: ["-display", ":99", "-forever", "-shared", "-localhost", "-rfbport", "5900", "-nopw", "-quiet"] },
  { name: "viewer", cmd: "node", args: ["/app/viewer/server.mjs"] },
  { name: "brave", display: true, before: prepareProfile, cmd: "brave-browser", args: [
    `--user-data-dir=${PROFILE}`, "--remote-debugging-port=9222", "--password-store=basic",
    "--no-first-run", "--no-default-browser-check", "--start-maximized",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--load-extension=/app/ridealong-cursor",
    // There's no GPU or GLX here: WebGL runs on the renderer Brave ships with.
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  ] },
];

const running = new Map();
let stopping = false;

const keepRunning = async (service) => {
  while (!stopping) {
    if (service.display) await waitForDisplay();
    service.before?.();
    const child = spawn(service.cmd, service.args, { stdio: ["ignore", "inherit", "inherit"] });
    running.set(service.name, child);
    const started = Date.now();
    await new Promise((resolve) => { child.on("exit", resolve); child.on("error", resolve); });
    running.delete(service.name);
    if (stopping) return;
    console.error(`supervise: ${service.name} stopped, restarting`);
    await sleep(Date.now() - started < 5000 ? 3000 : 500);
  }
};

const stop = async () => {
  stopping = true;
  for (const child of running.values()) child.kill("SIGTERM");
  // Give Brave time to save its profile before the display goes.
  const deadline = Date.now() + 15000;
  while (running.size && Date.now() < deadline) await sleep(100);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

fs.mkdirSync(process.env.HOME, { recursive: true });
pruneFiles();
setInterval(pruneFiles, 86400000).unref();
fs.mkdirSync("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
SERVICES.forEach(keepRunning);
