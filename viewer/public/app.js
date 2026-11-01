// The viewer. noVNC's RFB class draws the display; this file is the UI around it.
import RFB from "/vendor/novnc/core/rfb.js";
import KeyTable from "/vendor/novnc/core/input/keysym.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "ridealong-settings";
const DEFAULTS = { fit: true, dotCursor: true, quality: 6, compression: 2, panel: false, tab: "activity", appearance: "system" };
const PRESETS = {
  sharp: { quality: 8, compression: 2 },
  balanced: { quality: 6, compression: 2 },
  fast: { quality: 3, compression: 6 },
};

const load = () => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) }; }
  catch { return { ...DEFAULTS }; }
};
const settings = load();
const save = () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* optional */ }
};

let rfb = null;
let view = null;
let retry = 0;
let retryTimer;

const notice = (text) => { $("notice").textContent = text; $("notice").hidden = !text; };
const post = (url, body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
});

// Locked unless the service has said otherwise: losing it must never unlock.
const applyLock = () => {
  const locked = view ? view.locked : true;
  if (rfb) rfb.viewOnly = locked;
  document.body.classList.toggle("locked", locked);
  document.querySelectorAll(".needs-control").forEach((b) => { b.disabled = locked; });
  document.querySelectorAll(".control-hint").forEach((h) => { h.hidden = !locked; });
};

const applyDisplay = () => {
  if (!rfb) return;
  rfb.scaleViewport = settings.fit;
  rfb.clipViewport = !settings.fit;
  rfb.showDotCursor = settings.dotCursor;
  rfb.qualityLevel = settings.quality;
  rfb.compressionLevel = settings.compression;
};

const setConnection = (up) => {
  $("connection").textContent = up ? "Connected" : "Reconnecting";
  $("connection-dot").className = `dot${up ? " live" : ""}`;
  $("reconnect").hidden = up;
};

const connect = () => {
  clearTimeout(retryTimer);
  if (rfb) { const old = rfb; rfb = null; old.disconnect(); }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  rfb = new RFB($("screen"), `${scheme}://${location.host}/websockify`, { shared: true });
  rfb.background = "transparent";
  applyDisplay();
  applyLock();
  const current = rfb;
  rfb.addEventListener("connect", () => {
    retry = 0;
    const canvas = $("screen").querySelector("canvas");
    $("size").textContent = canvas ? `${canvas.width} × ${canvas.height}` : "";
    notice("");
    setConnection(true);
    applyDisplay();
    applyLock();
  });
  rfb.addEventListener("disconnect", () => {
    if (current !== rfb) return;
    rfb = null;
    setConnection(false);
    notice("Reconnecting");
    retry += 1;
    retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry));
  });
  rfb.addEventListener("clipboard", (e) => { $("clipboard").value = e.detail.text; });
};

const AGO = new Intl.RelativeTimeFormat(undefined, { style: "narrow" });
const ago = (at) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "Now";
  if (s < 3600) return AGO.format(-Math.round(s / 60), "minute");
  return AGO.format(-Math.round(s / 3600), "hour");
};

const WORKING_MS = 30000;

const base = (name) => name.toLowerCase().replace(/ \d+$/, "");

// With parallel sessions, pick whose tab the screen shows.
const renderRiders = () => {
  const list = view.sessions ?? [];
  $("riders").hidden = list.length < 2;
  $("riders").replaceChildren(...(list.length < 2 ? [] : list.map((x) => {
    const b = document.createElement("button");
    b.setAttribute("aria-current", String(x.followed));
    const orb = document.createElement("span");
    orb.className = "orb small";
    orb.dataset.agent = base(x.label);
    b.append(orb, x.label);
    b.addEventListener("click", () => post("/api/follow", { id: x.id }));
    return b;
  })));
};

const STEP_ICONS = [
  [/^Opening|^Going back/, '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'],
  [/^Typing|^Filling|^Pressing/, '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>'],
  [/^Asked/, '<path d="M12 8v5m0 3h.01"/><circle cx="12" cy="12" r="9"/>'],
  [/^Took|^Released|^Handed/, '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'],
];
const stepIcon = (s) => STEP_ICONS.find(([re]) => re.test(s.text))?.[1] ?? '<path d="m4 4 7 16 2.5-6.5L20 11Z"/>';

// Runs of steps by the same actor read as one group, newest first.
const renderActivity = () => {
  const groups = [];
  for (const a of view.activity) {
    const last = groups.at(-1);
    if (last?.who === a.who) last.steps.push(a);
    else groups.push({ who: a.who, at: a.at, steps: [a] });
  }
  $("activity").replaceChildren(...groups.map((g) => {
    const li = document.createElement("li");
    li.className = "group";
    const head = document.createElement("div");
    head.className = "group-head";
    const badge = document.createElement("span");
    badge.className = "orb small";
    badge.dataset.agent = base(g.who);
    const who = document.createElement("span");
    who.textContent = g.who;
    const time = document.createElement("time");
    time.textContent = ago(g.at);
    head.append(badge, who, time);
    li.append(head, ...g.steps.map((s) => {
      const step = document.createElement("div");
      step.className = s.ask ? "step ask" : "step";
      step.innerHTML = `<svg viewBox="0 0 24 24">${stepIcon(s)}</svg>`;
      const text = document.createElement("span");
      text.textContent = s.text;
      step.append(text);
      return step;
    }));
    return li;
  }));
  $("activity-empty").hidden = view.activity.length > 0;
};

const render = () => {
  if (!view) return;
  const { mode, turn, agent } = view;
  const working = agent && Date.now() - agent.at < WORKING_MS;
  const orb = $("avatar");
  orb.className = `orb${turn ? " turn" : working ? " live" : ""}`;
  orb.dataset.agent = mode === "control" && !turn ? "you" : base(turn ? turn.agent : working ? agent.name : "");
  if (turn) {
    $("who").textContent = "Your turn";
    $("what").textContent = `${turn.agent}: ${turn.reason}${view.waiting ? ` · ${view.waiting} more waiting` : ""}`;
  } else if (mode === "control") {
    $("who").textContent = "You have control";
    $("what").textContent = "Agents are waiting";
  } else if (working) {
    $("who").textContent = agent.name;
    $("what").textContent = agent.text;
  } else {
    $("who").textContent = "Standing by";
    $("what").textContent = "";
  }
  document.body.classList.toggle("turn", Boolean(turn));
  renderRiders();
  $("done").hidden = !turn;
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  });
  document.body.classList.toggle("in-control", !view.locked);
  renderActivity();
  document.title = turn ? "Your turn · Ridealong" : "Ridealong";
};

const listen = () => {
  const events = new EventSource("/api/events");
  events.onmessage = (e) => { view = JSON.parse(e.data); applyLock(); render(); };
  events.onerror = () => { view = null; applyLock(); };
};

const bind = (id, key, apply) => {
  const el = $(id);
  const isBox = el.type === "checkbox";
  const out = $(`${id}-out`);
  const show = () => {
    if (isBox) el.checked = settings[key]; else el.value = settings[key];
    if (out) out.textContent = settings[key];
  };
  show();
  el.addEventListener("input", () => {
    settings[key] = isBox ? el.checked : Number(el.value);
    show();
    save();
    apply();
  });
  return show;
};

const showPanel = (open) => {
  settings.panel = open;
  save();
  $("panel").hidden = !open;
  $("toggle-panel").setAttribute("aria-expanded", String(open));
};
const showTab = (tab) => {
  settings.tab = tab;
  save();
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  });
  $("pane-activity").hidden = tab !== "activity";
  $("pane-settings").hidden = tab !== "settings";
};

bind("fit", "fit", applyDisplay);
bind("dot-cursor", "dotCursor", applyDisplay);
const showPreset = () => {
  document.querySelectorAll("[data-preset]").forEach((b) => {
    const p = PRESETS[b.dataset.preset];
    b.setAttribute("aria-checked", String(p.quality === settings.quality && p.compression === settings.compression));
  });
};
const applyPicture = () => { applyDisplay(); showPreset(); };
const refreshQuality = bind("quality", "quality", applyPicture);
const refreshCompression = bind("compression", "compression", applyPicture);
showPreset();

document.querySelectorAll("[data-preset]").forEach((b) => {
  b.addEventListener("click", () => {
    Object.assign(settings, PRESETS[b.dataset.preset]);
    save();
    refreshQuality();
    refreshCompression();
    applyPicture();
  });
});

document.querySelectorAll("[data-mode]").forEach((b) => {
  b.addEventListener("click", () => post("/api/mode", { mode: b.dataset.mode }));
});
$("done").addEventListener("click", () => post("/api/done"));

// A click on a locked screen would otherwise do nothing and explain nothing.
let takeoverTimer;
$("screen").addEventListener("pointerdown", () => {
  if (!document.body.classList.contains("locked")) return;
  const name = view?.agent && Date.now() - view.agent.at < WORKING_MS ? view.agent.name : "";
  $("takeover-text").textContent = name ? `${name} is working` : "The screen is locked";
  $("takeover").hidden = false;
  clearTimeout(takeoverTimer);
  takeoverTimer = setTimeout(() => { $("takeover").hidden = true; }, 5000);
}, true);
$("take-control").addEventListener("click", () => {
  $("takeover").hidden = true;
  post("/api/mode", { mode: "control" });
});
$("toggle-panel").addEventListener("click", () => showPanel($("panel").hidden));
$("close-panel").addEventListener("click", () => showPanel(false));
document.querySelectorAll("[data-tab]").forEach((b) => {
  b.addEventListener("click", () => showTab(b.dataset.tab));
});
$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
$("reconnect").addEventListener("click", connect);
$("send-clipboard").addEventListener("click", () => rfb?.clipboardPasteFrom($("clipboard").value));

const KEYS = { esc: [KeyTable.XK_Escape, "Escape"], tab: [KeyTable.XK_Tab, "Tab"] };
document.querySelectorAll("[data-key]").forEach((b) => {
  b.addEventListener("click", () => {
    if (!rfb || rfb.viewOnly) return;
    if (b.dataset.key === "ctrl-alt-del") return rfb.sendCtrlAltDel();
    rfb.sendKey(...KEYS[b.dataset.key]);
  });
});

const showAppearance = () => {
  const root = document.documentElement;
  if (settings.appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.appearance;
  document.querySelectorAll("[data-appearance]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.appearance === settings.appearance));
  });
};
document.querySelectorAll("[data-appearance]").forEach((b) => {
  b.addEventListener("click", () => {
    settings.appearance = b.dataset.appearance;
    save();
    showAppearance();
  });
});

showAppearance();
showPanel(settings.panel);
showTab(settings.tab);
setInterval(render, 5000);
listen();
connect();
