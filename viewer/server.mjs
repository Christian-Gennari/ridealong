// The viewer service: serves the UI, relays VNC over a WebSocket, and holds the
// shared state (what the agent is doing, who has control). Agents reach it
// through mcp/ridealong-mcp.mjs and keep working if it is down.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { WebSocketServer } from "ws";

const HOST = process.env.VIEWER_HOST || "127.0.0.1";
const PORT = Number(process.env.VIEWER_PORT || 6086);
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const TOKEN = process.env.VIEWER_TOKEN || "";
const NOTIFY_URL = process.env.NOTIFY_URL || "";
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const ACTIVITY_LIMIT = 40;
const LONG_POLL_MS = 25000;

const MODES = new Set(["auto", "watch", "control"]);
const state = { mode: "auto", turns: [], activity: [] };
const sessions = new Map();
const streams = new Set();
let waiters = [];
let nextTurn = Date.now(); // never reused, so an agent can tell a restart from an answer
const answered = new Map(); // turn id to whether the human blocked it
let followed = null; // the session whose tab is in front
let pinned = false;  // the human chose this, so don't move on when it goes quiet
let shownTurn = null; // the handover we've already brought forward
let activated = null;
let agentTabsUntil = 0; // tab changes until then are an agent's doing, not the human's
const AGENT_TAB_MS = 2500;
const AGENT_START_MS = 20000; // a session's first tab can take this long to connect
const expectAgentTab = (ms = AGENT_TAB_MS) => { agentTabsUntil = Date.now() + ms; };

const ACTIVE_MS = 30000;
const SESSION_LOST_MS = 35000; // no heartbeat for this long means the agent died
// An agent client can keep a finished session alive for days, heartbeat and all.
// After this long without doing anything it leaves the list; 0 keeps it there.
const IDLE_HIDE_MS = Number(process.env.RIDEALONG_IDLE_HIDE_MIN ?? 15) * 60000;
const listed = (x) => x.text && (!IDLE_HIDE_MS || Date.now() - x.at < IDLE_HIDE_MS || state.turns.some((t) => t.session === x.id));
const active = () => [...sessions.values()].filter((x) => x.text && Date.now() - x.at < ACTIVE_MS);

// One session owns the screen at a time, so parallel agents don't flip tabs.
// A new handover comes forward once; after that the human decides where to look.
const pickFollowed = () => {
  const turn = state.turns[0];
  if (turn && turn.id !== shownTurn) {
    shownTurn = turn.id;
    followed = turn.session;
    pinned = true;
    return;
  }
  if (pinned && (followed === null || sessions.has(followed))) return;
  pinned = false;
  const live = active();
  if (live.some((x) => x.id === followed)) return;
  followed = live.sort((a, b) => b.at - a.at)[0]?.id ?? followed;
};

// Brings a session's tab forward straight away, over the browser's debugging port.
const activateTab = () => {
  const target = sessions.get(followed)?.target;
  if (!target || activated === target) return;
  activated = target;
  fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${target}`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
};

// An agent that was killed can't say goodbye, so sessions must keep checking in.
const closeTab = async (target) => {
  if (!target) return;
  const cdp = (route, init) => fetch(`http://127.0.0.1:${CDP_PORT}/json/${route}`, { signal: AbortSignal.timeout(1000), ...init });
  try {
    // Closing the last tab would quit Brave for everyone.
    const open = (await (await cdp("list")).json()).filter((t) => t.type === "page");
    if (open.length === 1) await cdp("new", { method: "PUT" });
    await cdp(`close/${target}`);
  } catch { /* Brave is down, and the tab with it */ }
};
const dropSession = (id, { closeItsTab = false } = {}) => {
  const session = sessions.get(id);
  if (!session) return;
  if (closeItsTab) closeTab(session.target);
  sessions.delete(id);
  state.turns = state.turns.filter((t) => t.session !== id);
};
let shownSessions = "";
setInterval(() => {
  const lost = [...sessions.values()].filter((x) => Date.now() - x.seen > SESSION_LOST_MS);
  lost.forEach((x) => dropSession(x.id, { closeItsTab: true }));
  const shown = [...sessions.values()].filter(listed).map((x) => x.id).join();
  if (lost.length || shown !== shownSessions) publish();
}, 5000).unref();

// Brave can freeze without exiting, and then nothing but a restart helps.
const BRAVE_CHECK_MS = 5000;
const BRAVE_STRIKES = 3;
let braveStrikes = 0;
const braveDown = () => braveStrikes >= BRAVE_STRIKES;
setInterval(async () => {
  const was = braveDown();
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    braveStrikes = 0;
  } catch {
    braveStrikes += 1;
  }
  if (was !== braveDown()) publish();
}, BRAVE_CHECK_MS).unref();

// Inside a container Brave only updates with the image.
const BRAVE_STALE_DAYS = 14;
const imageAge = () => (Date.now() / 1000 - Number(process.env.RIDEALONG_BUILT || Date.now() / 1000)) / 86400;

const canAct = () => state.mode !== "control";
// Control holds the session on screen. With nobody on screen it holds all of them.
const held = (session) => state.mode === "control" && (!session || followed === null || followed === session);
// Where a waiting agent stands: at the front its limit runs, behind it nothing does.
const place = (turn) => turn === state.turns[0] ? { front: true, left: Math.max(0, turn.deadline - Date.now()) } : { front: false, left: null };
const locked = () => state.mode === "watch" || (state.mode === "auto" && !state.turns.length);
const view = () => {
  const current = sessions.get(followed);
  return {
    mode: state.mode, turn: state.turns[0] ?? null, waiting: Math.max(0, state.turns.length - 1),
    agent: current?.text ? { name: current.label, text: current.text, at: current.at } : null,
    sessions: [...sessions.values()].filter(listed).map((x) => ({
      id: x.id, label: x.label, followed: x.id === followed, text: x.text, at: x.at,
      needsYou: state.turns.some((t) => t.session === x.id),
    })),
    elsewhere: followed === null && pinned,
    turnHere: state.turns[0]?.session === followed,
    activity: state.activity, locked: locked(), paused: !canAct(),
    braveDown: braveDown(), version: process.env.RIDEALONG_VERSION || "dev",
    rules, staleDays: imageAge() > BRAVE_STALE_DAYS ? Math.floor(imageAge()) : 0,
  };
};

// A turn's time limit counts from when it comes forward, not from when it was asked.
const startFront = () => {
  const turn = state.turns[0];
  if (turn && !turn.deadline) turn.deadline = Date.now() + turn.limit;
};

const publish = () => {
  startFront();
  shownSessions = [...sessions.values()].filter(listed).map((x) => x.id).join();
  pickFollowed();
  activateTab();
  const frame = `data: ${JSON.stringify(view())}\n\n`;
  for (const res of streams) res.write(frame);
  const ready = waiters;
  waiters = [];
  ready.forEach((wake) => wake());
};

const log = (who, text, extra) => {
  if (!extra?.answers && state.activity[0]?.who === who && state.activity[0]?.text === text) return;
  state.activity.unshift({ who, text, at: Date.now(), ...extra });
  state.activity.length = Math.min(state.activity.length, ACTIVITY_LIMIT);
};

// Waits for the next state change, or the long-poll limit.
const nextChange = () => new Promise((resolve) => {
  const timer = setTimeout(resolve, LONG_POLL_MS);
  waiters.push(() => { clearTimeout(timer); resolve(); });
});

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// A page that points its own domain at 127.0.0.1 passes the origin check below,
// and the browser on this machine visits untrusted pages all day. Nothing but
// the addresses we were given should reach the viewer. A token already covers it.
const hostname = (value) => {
  try { return new URL(`http://${value}`).hostname; } catch { return ""; }
};
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", ...(process.env.ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)]);
try { ALLOWED_HOSTS.add(new URL(process.env.VIEWER_URL).hostname); } catch { /* not set */ }
const hostAllowed = (req) => Boolean(TOKEN) || ALLOWED_HOSTS.has(hostname(req.headers.host));

const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")));

// Without this, any website open on a tailnet device could drive the browser.
const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return host === req.headers.host || host === req.headers["x-forwarded-host"];
};

const authorised = (req, url) => {
  if (!TOKEN) return true;
  return cookies(req).ridealong === TOKEN
    || url.searchParams.get("token") === TOKEN
    || req.headers["x-ridealong-token"] === TOKEN;
};

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 8192) { reject(new Error("too large")); req.destroy(); }
  });
  req.on("end", () => {
    try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
  });
  req.on("error", reject);
});

// Sites where agents must ask before acting. The wrapper enforces this.
const RULES_FILE = process.env.RULES_FILE || "";
const loadRules = () => {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, "utf8")).hosts ?? []; } catch { return []; }
};
let rules = loadRules();
const cleanHost = (value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, ""); } catch { return ""; }
};
const saveRules = () => {
  if (!RULES_FILE) return;
  fs.writeFileSync(`${RULES_FILE}.tmp`, JSON.stringify({ hosts: rules }));
  fs.renameSync(`${RULES_FILE}.tmp`, RULES_FILE);
};

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Web push: the devices you turned notifications on for hear about a turn even
// with the viewer closed, whichever agent client asked. Keys and subscriptions
// live next to the Brave profile, so they survive updates.
const PUSH_FILE = process.env.PUSH_FILE || "";
const pushState = (() => {
  try { return JSON.parse(fs.readFileSync(PUSH_FILE, "utf8")); } catch { /* first start */ }
  return { ...webpush.generateVAPIDKeys(), subscriptions: [] };
})();
const savePush = () => {
  if (!PUSH_FILE) return;
  fs.writeFileSync(`${PUSH_FILE}.tmp`, JSON.stringify(pushState), { mode: 0o600 });
  fs.renameSync(`${PUSH_FILE}.tmp`, PUSH_FILE);
};
savePush();
webpush.setVapidDetails("https://github.com/Christian-Gennari/ridealong", pushState.publicKey, pushState.privateKey);

// Push services are on the internet; anything else is someone pointing us elsewhere.
const pushEndpoint = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch { return false; }
};

const pushTurn = (turn) => {
  const approval = turn.kind === "approval";
  const payload = JSON.stringify({
    title: approval ? `Allow ${turn.agent}?` : `Your turn: ${turn.agent}`,
    body: approval ? `${turn.agent} wants to click and type on ${turn.host}.` : turn.reason,
  });
  for (const subscription of pushState.subscriptions) {
    webpush.sendNotification(subscription, payload, { TTL: 600, urgency: "high" }).catch((e) => {
      // The browser dropped this subscription, so stop sending to it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        pushState.subscriptions = pushState.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
        savePush();
      } else console.error(`push: ${e.statusCode ?? e.message}`);
    });
  }
};

// A push for when nobody's looking at the viewer. Plain text, so ntfy works as is.
const notify = (turn) => {
  if (!NOTIFY_URL) return;
  fetch(NOTIFY_URL, {
    method: "POST",
    headers: { Title: `Your turn: ${turn.agent}`, ...(process.env.VIEWER_URL ? { Click: process.env.VIEWER_URL } : {}) },
    body: turn.reason,
    signal: AbortSignal.timeout(5000),
  }).catch((e) => console.error(`notify: ${e.message}`));
};

const api = {
  "GET /api/events": (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.write(`data: ${JSON.stringify(view())}\n\n`);
    streams.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); streams.delete(res); });
  },
  "GET /api/health": (req, res) => json(res, braveDown() ? 503 : 200, { version: process.env.RIDEALONG_VERSION || "dev", sessions: sessions.size }),
  "POST /api/brave/restart": (req, res) => {
    if (!braveDown()) return json(res, 409, { error: "Brave is responding" });
    // The supervisor starts it again.
    execFile("pkill", ["-9", "-x", "brave"], () => json(res, 200, {}));
  },
  "GET /api/push": (req, res) => json(res, 200, { key: pushState.publicKey, devices: pushState.subscriptions.length }),
  "POST /api/push/subscribe": async (req, res) => {
    const { subscription } = await readBody(req);
    const { endpoint, keys } = subscription ?? {};
    if (!pushEndpoint(endpoint) || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") return json(res, 400, { error: "subscription" });
    pushState.subscriptions = [...pushState.subscriptions.filter((s) => s.endpoint !== endpoint), { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }].slice(-20);
    savePush();
    json(res, 200, { devices: pushState.subscriptions.length });
  },
  "POST /api/push/unsubscribe": async (req, res) => {
    const { endpoint } = await readBody(req);
    pushState.subscriptions = pushState.subscriptions.filter((s) => s.endpoint !== endpoint);
    savePush();
    json(res, 200, {});
  },
  "GET /api/rules": (req, res) => json(res, 200, { hosts: rules }),
  "POST /api/rules": async (req, res) => {
    const { hosts } = await readBody(req);
    if (!Array.isArray(hosts)) return json(res, 400, { error: "hosts" });
    rules = [...new Set(hosts.map(cleanHost).filter(Boolean))].sort();
    saveRules();
    publish();
    json(res, 200, { hosts: rules });
  },
  "GET /api/gate": async (req, res, url) => {
    const session = url.searchParams.get("session");
    if (held(session)) await nextChange();
    json(res, 200, { go: !held(session) });
  },
  "POST /api/session": async (req, res) => {
    const { agent, label: wanted, text, target } = await readBody(req);
    const base = clip(agent, 24) || "Agent";
    const taken = new Set([...sessions.values()].map((x) => x.label));
    // A wrapper that outlived a viewer restart asks for its old label back.
    let name = clip(wanted, 30);
    if (!name || taken.has(name)) {
      let n = 1;
      while (taken.has(n === 1 ? base : `${base} ${n}`)) n += 1;
      name = n === 1 ? base : `${base} ${n}`;
    }
    // Random ids are never reused, so a wrapper can tell a restart from a 404.
    const session = { id: crypto.randomUUID(), label: name, text: "", at: 0, seen: Date.now() };
    // Its last status and tab come back too, so it shows in the dropdown at once.
    if (typeof text === "string" && text) { session.text = clip(text, 80); session.at = Date.now(); }
    if (typeof target === "string" && /^[A-Z0-9]+$/i.test(target)) session.target = target;
    sessions.set(session.id, session);
    expectAgentTab(AGENT_START_MS);
    json(res, 200, { id: session.id, label: session.label });
  },
  // An agent is about to change tabs; opening one also pulls it to the front.
  "POST /api/session/tabs": async (req, res) => {
    expectAgentTab();
    json(res, 200, {});
  },
  "POST /api/session/target": async (req, res) => {
    const { id, target } = await readBody(req);
    const current = sessions.get(id);
    if (current && typeof target === "string" && /^[A-Z0-9]+$/i.test(target)) {
      current.target = target;
      expectAgentTab();
      // Put back whatever the human was looking at.
      activated = null;
      activateTab();
    }
    json(res, 200, {});
  },
  "POST /api/session/end": async (req, res) => {
    const { id } = await readBody(req);
    dropSession(id);
    publish();
    json(res, 200, {});
  },
  "POST /api/session/beat": async (req, res) => {
    const current = sessions.get((await readBody(req)).id);
    if (current) current.seen = Date.now();
    json(res, current ? 200 : 404, {});
  },
  "POST /api/activity": async (req, res) => {
    const { session, text, quiet } = await readBody(req);
    const current = sessions.get(session);
    if (!current) return json(res, 404, {});
    current.text = clip(text, 80);
    current.at = Date.now();
    if (!quiet) log(current.label, current.text, { session });
    publish();
    json(res, 200, { front: followed === session });
  },
  "POST /api/follow": async (req, res) => {
    const { id } = await readBody(req);
    if (sessions.has(id)) { followed = id; pinned = true; activated = null; publish(); }
    json(res, 200, {});
  },
  // From the Ridealong extension: the human clicked a tab in Brave.
  "POST /api/focus": async (req, res) => {
    const { session } = await readBody(req);
    const id = sessions.has(session) ? session : null;
    if (Date.now() < agentTabsUntil) return json(res, 200, {});
    if (id !== followed) { followed = id; pinned = true; activated = sessions.get(id)?.target ?? null; publish(); }
    json(res, 200, {});
  },
  "POST /api/handover": async (req, res) => {
    const { session, reason, minutes, kind, host } = await readBody(req);
    const current = sessions.get(session);
    if (!current) return json(res, 404, {});
    const at = Date.now();
    const turn = { id: ++nextTurn, session, agent: current.label, reason: clip(reason, 140), at, limit: (Number(minutes) || 10) * 60000, deadline: null,
      kind: kind === "approval" ? "approval" : "handover", host: clip(host, 80) };
    state.turns.push(turn);
    current.text = "Waiting for you";
    current.at = at;
    log(turn.agent, turn.kind === "approval" ? `Wants to act on ${turn.host}` : `Asked you: ${turn.reason}`, { ask: true, session, turn: turn.id });
    notify(turn);
    pushTurn(turn);
    publish();
    json(res, 200, { id: turn.id, ...place(turn) });
  },
  "GET /api/handover/wait": async (req, res, url) => {
    const id = Number(url.searchParams.get("id"));
    if (state.turns.some((t) => t.id === id)) await nextChange();
    const open = state.turns.some((t) => t.id === id);
    const turn = state.turns.find((t) => t.id === id);
    json(res, 200, { done: answered.has(id), blocked: answered.get(id) === true, lost: !open && !answered.has(id), ...(turn ? place(turn) : {}) });
  },
  "POST /api/handover/cancel": async (req, res) => {
    const { id } = await readBody(req);
    const turn = state.turns.find((t) => t.id === id);
    if (turn) log(turn.agent, "Stopped waiting for you", { ask: true, session: turn.session, answers: turn.id, waited: Date.now() - turn.at });
    state.turns = state.turns.filter((t) => t.id !== id);
    publish();
    json(res, 200, {});
  },
  // Names the turn, so a double click or a second device can't answer the next one.
  "POST /api/done": async (req, res) => {
    const { id, blocked } = await readBody(req);
    const turn = state.turns.find((t) => t.id === id);
    if (turn) {
      state.turns = state.turns.filter((t) => t !== turn);
      answered.set(turn.id, Boolean(blocked));
      const asker = sessions.get(turn.session);
      if (asker) { asker.text = "Carrying on"; asker.at = Date.now(); }
      log("You", turn.kind !== "approval" ? (blocked ? "Declined" : "Handed back") : `${blocked ? "Blocked" : "Allowed"} ${turn.agent} on ${turn.host}`,
        { session: turn.session, answers: turn.id, waited: Date.now() - turn.at });
    }
    if (!state.turns.length) pinned = false;
    if (state.mode === "control" && !state.turns.length) state.mode = "auto";
    publish();
    json(res, 200, {});
  },
  "POST /api/mode": async (req, res) => {
    const { mode } = await readBody(req);
    if (!MODES.has(mode)) return json(res, 400, { error: "unknown mode" });
    if (mode !== state.mode && mode === "control") log("You", "Took control");
    if (mode !== state.mode && state.mode === "control") log("You", "Released control");
    state.mode = mode;
    publish();
    json(res, 200, {});
  },
};

const serveStatic = (res, pathname) => {
  const name = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(name)));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, {});
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, {});
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": /^\/(vendor|fonts)\//.test(name) ? "public, max-age=86400" : "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
};

// The extension can only change which session the viewer shows, nothing else.
const fromExtension = (req, url) => url.pathname === "/api/focus"
  && req.socket.remoteAddress === "127.0.0.1"
  && (req.headers.origin ?? "").startsWith("chrome-extension://");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!hostAllowed(req)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`This address isn't allowed. Add ${hostname(req.headers.host)} with: ridealong up --allow-host ${hostname(req.headers.host)}`);
  }
  const extension = fromExtension(req, url);
  if (!extension && !authorised(req, url)) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Open the link ridealong up printed, including its token.");
  }
  if (TOKEN && url.searchParams.get("token") === TOKEN) {
    res.setHeader("Set-Cookie", `ridealong=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
  }
  if (req.method === "POST" && !extension && !sameOrigin(req)) return json(res, 403, { error: "origin" });
  const route = api[`${req.method} ${url.pathname}`];
  try {
    if (route) return await route(req, res, url);
    if (req.method === "GET") return serveStatic(res, url.pathname);
    json(res, 404, {});
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
  }
});

const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("binary") ? "binary" : false) });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/websockify" || !hostAllowed(req) || !authorised(req, url) || !sameOrigin(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const vnc = net.connect(VNC_PORT, "127.0.0.1");
    vnc.on("data", (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    ws.on("message", (d) => vnc.write(d));
    vnc.on("close", () => ws.close());
    vnc.on("error", () => ws.close());
    ws.on("close", () => vnc.destroy());
    ws.on("error", () => vnc.destroy());
  });
});

server.listen(PORT, HOST, () => console.log(`viewer on http://${HOST}:${PORT}`));
