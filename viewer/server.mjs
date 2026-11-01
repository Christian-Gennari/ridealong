// The viewer service: serves the UI, relays VNC over a WebSocket, and holds the
// shared state (what the agent is doing, who has control). Agents reach it
// through mcp/ridealong-mcp.mjs and keep working if it is down.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HOST = process.env.VIEWER_HOST || "127.0.0.1";
const PORT = Number(process.env.VIEWER_PORT || 6086);
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const TOKEN = process.env.VIEWER_TOKEN || "";
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const ACTIVITY_LIMIT = 40;
const LONG_POLL_MS = 25000;

const MODES = new Set(["auto", "watch", "control"]);
const state = { mode: "auto", turns: [], activity: [] };
const sessions = new Map();
const streams = new Set();
let waiters = [];
let nextTurn = 0;
let nextSession = 0;
let followed = null; // the session whose tab is in front
let pinned = false;  // the human chose this, so don't move on when it goes quiet
let shownTurn = null; // the handover we've already brought forward
let activated = null;
let agentTabsUntil = 0; // tab changes until then are an agent's doing, not the human's
const AGENT_TAB_MS = 2500;
const AGENT_START_MS = 20000; // a session's first tab can take this long to connect
const expectAgentTab = (ms = AGENT_TAB_MS) => { agentTabsUntil = Date.now() + ms; };

const ACTIVE_MS = 30000;
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

const canAct = () => state.mode !== "control";
const locked = () => state.mode === "watch" || (state.mode === "auto" && !state.turns.length);
const view = () => {
  const current = sessions.get(followed);
  return {
    mode: state.mode, turn: state.turns[0] ?? null, waiting: Math.max(0, state.turns.length - 1),
    agent: current?.text ? { name: current.label, text: current.text, at: current.at } : null,
    sessions: [...sessions.values()].filter((x) => x.text).map((x) => ({ id: x.id, label: x.label, followed: x.id === followed })),
    elsewhere: followed === null && pinned,
    activity: state.activity, locked: locked(), paused: !canAct(),
  };
};

const publish = () => {
  pickFollowed();
  activateTab();
  const frame = `data: ${JSON.stringify(view())}\n\n`;
  for (const res of streams) res.write(frame);
  const ready = waiters;
  waiters = [];
  ready.forEach((wake) => wake());
};

const log = (who, text, extra) => {
  if (state.activity[0]?.who === who && state.activity[0]?.text === text) return;
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
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

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

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const api = {
  "GET /api/events": (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.write(`data: ${JSON.stringify(view())}\n\n`);
    streams.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); streams.delete(res); });
  },
  "GET /api/gate": async (req, res) => {
    if (!canAct()) await nextChange();
    json(res, 200, { go: canAct() });
  },
  "POST /api/session": async (req, res) => {
    const { agent } = await readBody(req);
    const base = clip(agent, 24) || "Agent";
    const taken = new Set([...sessions.values()].map((x) => x.label));
    let n = 1;
    while (taken.has(n === 1 ? base : `${base} ${n}`)) n += 1;
    const session = { id: String(++nextSession), label: n === 1 ? base : `${base} ${n}`, text: "", at: 0 };
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
    sessions.delete(id);
    state.turns = state.turns.filter((t) => t.session !== id);
    publish();
    json(res, 200, {});
  },
  "POST /api/activity": async (req, res) => {
    const { session, text, quiet } = await readBody(req);
    const current = sessions.get(session);
    if (!current) return json(res, 404, {});
    current.text = clip(text, 80);
    current.at = Date.now();
    if (!quiet) log(current.label, current.text);
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
    const { session, reason } = await readBody(req);
    const current = sessions.get(session);
    if (!current) return json(res, 404, {});
    const turn = { id: ++nextTurn, session, agent: current.label, reason: clip(reason, 140), at: Date.now() };
    state.turns.push(turn);
    log(turn.agent, `Asked you: ${turn.reason}`, { ask: true });
    publish();
    json(res, 200, { id: turn.id });
  },
  "GET /api/handover/wait": async (req, res, url) => {
    const id = Number(url.searchParams.get("id"));
    if (state.turns.some((t) => t.id === id)) await nextChange();
    json(res, 200, { done: !state.turns.some((t) => t.id === id) });
  },
  "POST /api/handover/cancel": async (req, res) => {
    const { id } = await readBody(req);
    state.turns = state.turns.filter((t) => t.id !== id);
    publish();
    json(res, 200, {});
  },
  "POST /api/done": async (req, res) => {
    if (state.turns.shift()) log("You", "Handed back");
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
  const extension = fromExtension(req, url);
  if (!extension && !authorised(req, url)) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Open the link the installer printed, including its token.");
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
  if (url.pathname !== "/websockify" || !authorised(req, url) || !sameOrigin(req)) return socket.destroy();
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
