// Runs the cursor extension's background worker against the real server,
// with a fake Brave behind the chrome API it uses.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import vm from "node:vm";

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const WORKER = fs.readFileSync(new URL("../../ridealong-cursor/background.js", import.meta.url), "utf8");
const running = [];
after(() => running.forEach((c) => c.kill()));

const start = async (port, agentStartMs = 0) => {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, VIEWER_PORT: String(port), VNC_PORT: "1", CDP_PORT: "1", AGENT_START_MS: String(agentStartMs), AGENT_TAB_MS: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  running.push(child);
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return `http://127.0.0.1:${port}`;
};

// Windows hold tabs; one window has focus, and each has one active tab.
const brave = () => {
  const windows = new Map();
  let focused = null;
  const store = {};
  const listeners = { activated: [], focus: [], message: [] };
  const fire = (name, arg) => Promise.all(listeners[name].map((f) => f(...[].concat(arg))));
  const chrome = {
    storage: { session: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (items) => { Object.assign(store, structuredClone(items)); },
    } },
    tabs: {
      onActivated: { addListener: (f) => listeners.activated.push(f) },
      query: async ({ windowId }) => {
        const w = windows.get(windowId);
        return w ? [{ id: w.active, windowId, groupId: -1 }] : [];
      },
      group: async () => 1,
    },
    tabGroups: { TAB_GROUP_ID_NONE: -1, query: async () => [], update: async () => {} },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: (f) => listeners.focus.push(f) },
      getLastFocused: async () => ({ id: focused, focused: focused !== null }),
    },
    runtime: { onMessage: { addListener: (f) => listeners.message.push(f) } },
  };
  return {
    chrome,
    // A tab in a window of its own, brought to the front.
    openWindow: async (windowId, tabId) => { windows.set(windowId, { active: tabId }); focused = windowId; await fire("focus", windowId); },
    focusWindow: async (windowId) => { focused = windowId; await fire("focus", windowId); },
    activate: async (windowId, tabId) => { windows.get(windowId).active = tabId; await fire("activated", { tabId, windowId }); },
    // What the cursor script sends when the agent's first message reaches a page.
    cursorMessage: (tabId, session, viewer) => fire("message", [{ group: "Claude", session, viewer }, { tab: { id: tabId, windowId: 0, groupId: -1 } }]),
  };
};

const load = (fake) => {
  // Brave sends the extension's origin, which is what the server checks.
  const fetchAsExtension = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: "chrome-extension://ridealong" } });
  vm.runInNewContext(WORKER, { chrome: fake.chrome, fetch: fetchAsExtension, setTimeout });
};

const settle = () => new Promise((r) => setTimeout(r, 150));

const view = (base) => new Promise((resolve, reject) => {
  const req = http.get(`${base}/api/events`, (res) => {
    res.once("data", (chunk) => { req.destroy(); resolve(JSON.parse(String(chunk).slice(6))); });
  });
  req.on("error", () => {});
});

const join = async (base, agent) => {
  const res = await fetch(`${base}/api/session`, { method: "POST", body: JSON.stringify({ agent }) });
  const { id } = await res.json();
  await fetch(`${base}/api/activity`, { method: "POST", body: JSON.stringify({ session: id, text: "Working on the page" }) });
  return id;
};

test("a tab reported before its owner is known ends up followed once the owner is", async () => {
  const base = await start(16241);
  const fake = brave();
  load(fake);
  const id = await join(base, "Claude");
  // The extension learns the viewer's address from the first owned tab, here one in no window.
  await fake.cursorMessage(99, id, base);
  // The session's window opens and its tab comes to the front before the page names its owner.
  await fake.openWindow(1, 10);
  await fake.activate(1, 10);
  await settle();
  let v = await view(base);
  assert.equal(v.elsewhere, true, "an unowned tab reads as the human's own");
  assert.equal(v.sessions.find((s) => s.id === id).followed, false);
  // The agent's first cursor message names the owner of the tab on screen.
  await fake.cursorMessage(10, id, base);
  await settle();
  v = await view(base);
  assert.equal(v.elsewhere, false);
  assert.equal(v.sessions.find((s) => s.id === id).followed, true, "the session on screen is followed");
});

test("an owner learned for a tab behind the one on screen changes nothing", async () => {
  const base = await start(16242);
  const fake = brave();
  load(fake);
  const id = await join(base, "Claude");
  await fake.cursorMessage(99, id, base);
  await fake.openWindow(1, 10);
  // The human opens a window of their own on top.
  await fake.openWindow(2, 20);
  await fake.activate(2, 20);
  await settle();
  await fake.cursorMessage(10, id, base);
  await settle();
  const v = await view(base);
  assert.equal(v.elsewhere, true, "the human's own tab stays in front");
  assert.equal(v.sessions.find((s) => s.id === id).followed, false);
});

test("moving to another session's window follows that session", async () => {
  const base = await start(16243);
  const fake = brave();
  load(fake);
  const one = await join(base, "Claude");
  const two = await join(base, "Codex");
  await fake.cursorMessage(10, one, base);
  await fake.cursorMessage(20, two, base);
  await fake.openWindow(1, 10);
  await settle();
  await fake.openWindow(2, 20);
  await settle();
  assert.equal((await view(base)).sessions.find((s) => s.id === two).followed, true);
  // Switching windows activates no tab, only focus moves.
  await fake.focusWindow(1);
  await settle();
  assert.equal((await view(base)).sessions.find((s) => s.id === one).followed, true);
});

test("an owner learned while a session is starting is reported once the viewer listens", async () => {
  const base = await start(16244, 800);
  const fake = brave();
  load(fake);
  const gone = await join(base, "Claude");
  await fake.cursorMessage(99, gone, base);
  await new Promise((r) => setTimeout(r, 900));
  // A session's tab closed and Brave fell back to a blank tab of the human's.
  await fake.openWindow(3, 30);
  await settle();
  await fetch(`${base}/api/session/end`, { method: "POST", body: JSON.stringify({ id: gone }) });
  assert.equal((await view(base)).elsewhere, true);
  // A new session starts, and its tab names its owner while the viewer still ignores tab changes.
  const id = await join(base, "Claude");
  await fake.openWindow(1, 10);
  await fake.cursorMessage(10, id, base);
  await settle();
  assert.equal((await view(base)).sessions.find((s) => s.id === id).followed, false, "too early to be taken");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal((await view(base)).sessions.find((s) => s.id === id).followed, true, "taken after the start window");
});
