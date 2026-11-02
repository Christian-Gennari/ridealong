// The viewer. noVNC's RFB class draws the display; this file is the UI around it.
import RFB from "/vendor/novnc/core/rfb.js";
import KeyTable from "/vendor/novnc/core/input/keysym.js";
import keysyms from "/vendor/novnc/core/input/keysymdef.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "ridealong-settings";
const DEFAULTS = { fit: true, dotCursor: true, quality: 6, compression: 2, panel: false, tab: "activity", appearance: "system", sound: true, notifications: false };
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

const orbFor = (label, small = true) => {
  const orb = document.createElement("span");
  orb.className = small ? "orb small" : "orb";
  orb.dataset.agent = base(label);
  return orb;
};

const openPicker = (open) => {
  $("picker-list").hidden = !open;
  $("picker-button").setAttribute("aria-expanded", String(open));
  if (open) $("picker-list").querySelector("[aria-selected='true'], button")?.focus();
};

// With parallel sessions, pick whose tab the screen shows.
const renderPicker = () => {
  const list = view.sessions ?? [];
  const many = list.length > 1;
  $("picker").hidden = !many;
  document.body.classList.toggle("someone-waiting", list.some((x) => x.needsYou && !x.followed));
  if (!many) return openPicker(false);
  $("picker-count").textContent = `${list.length} sessions`;
  $("picker-orbs").replaceChildren(...list.slice(0, 3).map((x) => orbFor(x.label)));
  const focused = document.activeElement?.dataset?.session;
  $("picker-list").replaceChildren(...list.map((x) => {
    const li = document.createElement("li");
    li.setAttribute("role", "presentation");
    const b = document.createElement("button");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(x.followed));
    b.dataset.session = x.id;
    const copy = document.createElement("span");
    copy.className = "picker-copy";
    const name = document.createElement("span");
    name.textContent = x.label;
    const doing = document.createElement("span");
    doing.className = "picker-doing";
    doing.textContent = Date.now() - x.at < WORKING_MS || x.needsYou ? x.text : "Idle";
    copy.append(name, doing);
    b.append(orbFor(x.label), copy);
    if (x.needsYou) {
      const tag = document.createElement("span");
      tag.className = "picker-tag";
      tag.textContent = "Needs you";
      b.append(tag);
    }
    b.addEventListener("click", () => {
      openPicker(false);
      $("picker-button").focus();
      post("/api/follow", { id: x.id });
    });
    li.append(b);
    return li;
  }));
  if (focused) $("picker-list").querySelector(`[data-session="${focused}"]`)?.focus();
};

$("picker-button").addEventListener("click", () => openPicker($("picker-list").hidden));
$("picker-list").addEventListener("keydown", (e) => {
  const items = [...$("picker-list").querySelectorAll("button")];
  const at = items.indexOf(document.activeElement);
  if (e.key === "Escape") { openPicker(false); $("picker-button").focus(); }
  if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
});
// In the capture phase, because the screen keeps the clicks it gets.
document.addEventListener("pointerdown", (e) => {
  if (!$("picker").contains(e.target)) openPicker(false);
}, true);

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

const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const saveRules = (hosts) => post("/api/rules", { hosts });
const renderRules = () => {
  $("rules").replaceChildren(...(view.rules ?? []).map((host) => {
    const li = document.createElement("li");
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.className = "link";
    remove.setAttribute("aria-label", `Remove ${host}`);
    remove.addEventListener("click", () => saveRules(view.rules.filter((h) => h !== host)));
    li.append(host, remove);
    return li;
  }));
};
$("rule-form").addEventListener("submit", (e) => {
  e.preventDefault();
  saveRules([...(view?.rules ?? []), $("rule-host").value]);
  $("rule-host").value = "";
});

const renderTurnClock = () => {
  const turn = view?.turn;
  if (!turn) return;
  const parts = [`${turn.agent} stops waiting in ${clock(turn.deadline - Date.now())}`];
  if (view.waiting) parts.push(`${view.waiting} more waiting`);
  $("turn-sub").textContent = parts.join(" · ");
};

const renderTurn = () => {
  const { turn, mode } = view;
  $("turn").hidden = !turn;
  document.body.classList.toggle("turn", Boolean(turn));
  if (turn) document.body.dataset.agent = base(turn.agent);
  else delete document.body.dataset.agent;
  $("theme-color").content = turn ? getComputedStyle(document.body).getPropertyValue("--c").trim() : "#fdfcfc";
  if (!turn) return;
  const approval = turn.kind === "approval";
  $("turn-orb").dataset.agent = base(turn.agent);
  $("turn-title").textContent = approval ? `Allow ${turn.agent}?` : "Your turn";
  $("done-label").textContent = approval ? "Allow for 10 minutes" : "Hand back";
  $("turn-block").hidden = !approval;
  $("turn-reason").textContent = approval ? `${turn.agent} wants to click and type on ${turn.host}.` : `${turn.agent}: ${turn.reason}`;
  const fix = !view.turnHere ? `Go to ${turn.agent}'s tab` : mode === "watch" && !approval ? "Unlock the screen" : "";
  $("turn-fix").textContent = fix;
  $("turn-fix").hidden = !fix;
  renderTurnClock();
};

$("turn-fix").addEventListener("click", () => {
  if (!view.turnHere) post("/api/follow", { id: view.turn.session });
  else post("/api/mode", { mode: "auto" });
});

// Once per request: the moment it arrives is the moment to get noticed.
let chime = null;
const beep = () => {
  if (!settings.sound || !chime) return;
  [[660, 0], [880, 0.16]].forEach(([freq, delay]) => {
    const tone = chime.createOscillator();
    const gain = chime.createGain();
    const at = chime.currentTime + delay;
    tone.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.12, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
    tone.connect(gain).connect(chime.destination);
    tone.start(at);
    tone.stop(at + 0.5);
  });
};
// Browsers only allow sound after a click, so wake it on the first one.
document.addEventListener("pointerdown", () => {
  chime ??= new AudioContext();
  chime.resume();
}, { once: true, capture: true });

// Through the service worker where there is one, which is the only way on Android.
const worker = window.isSecureContext && "serviceWorker" in navigator
  ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null);

// Push reaches this device even with the viewer closed. Not every browser has a
// push service (Brave keeps it off), so the page notifies by itself as well.
const urlKey = (base64) => Uint8Array.from(atob((base64 + "=".repeat((4 - base64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
let pushing = false;
const subscribe = async () => {
  try {
    const registration = await worker;
    if (!registration?.pushManager) return false;
    const { key } = await (await fetch("/api/push")).json();
    const subscription = await registration.pushManager.getSubscription()
      ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) });
    pushing = (await post("/api/push/subscribe", { subscription })).ok;
  } catch {
    pushing = false;
  }
  return pushing;
};
const unsubscribe = async () => {
  const subscription = await (await worker)?.pushManager?.getSubscription().catch(() => null);
  if (!subscription) return;
  await post("/api/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
  pushing = false;
};

const notifyDevice = async (turn) => {
  if (pushing || !settings.notifications || document.hasFocus() || window.Notification?.permission !== "granted") return;
  const approval = turn.kind === "approval";
  const title = approval ? `Allow ${turn.agent}?` : `Your turn: ${turn.agent}`;
  const options = { body: approval ? `${turn.agent} wants to click and type on ${turn.host}.` : turn.reason, tag: "ridealong-turn", renotify: true, requireInteraction: true, icon: "/icon-192.png" };
  try {
    const registration = await worker;
    if (registration) return await registration.showNotification(title, options);
    const note = new Notification(title, options);
    note.onclick = () => { window.focus(); note.close(); };
  } catch { /* nothing more to try */ }
};

// Without this, a request waits unseen whenever the viewer isn't in front of you.
const nudge = () => {
  const show = NOTIFY_OK && Notification.permission === "default" && !settings.notifications && !settings.nudged;
  $("nudge").hidden = !show;
};
$("nudge-yes").addEventListener("click", async () => {
  settings.nudged = true;
  settings.notifications = (await Notification.requestPermission()) === "granted";
  save();
  refreshNotifications();
  nudge();
  if (settings.notifications) subscribe();
});
$("nudge-no").addEventListener("click", () => { settings.nudged = true; save(); nudge(); });

const flash = (turn) => {
  const approval = turn.kind === "approval";
  $("turn-flash-title").textContent = approval ? `Allow ${turn.agent}?` : "Your turn";
  $("turn-flash-text").textContent = approval ? `${turn.agent} wants to click and type on ${turn.host}.` : `${turn.agent}: ${turn.reason}`;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  $("turn-flash").hidden = true;
  void $("turn-flash").offsetWidth; // so a second request plays it again
  $("turn-flash").hidden = false;
};
$("turn-flash").addEventListener("animationend", (e) => { if (e.target === $("turn-flash")) $("turn-flash").hidden = true; });

const favicon = $("favicon").href;
const turnIcon = (colour) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='${colour}'/></svg>`)}`;

let seenTurn = null;
const announce = () => {
  const turn = view.turn;
  if (turn?.id === seenTurn) return;
  seenTurn = turn?.id ?? null;
  $("favicon").href = turn ? turnIcon(getComputedStyle(document.body).getPropertyValue("--c").trim()) : favicon;
  $("done").disabled = false;
  if (!turn) return;
  flash(turn);
  beep();
  notifyDevice(turn);
  // So the code can be typed straight away, without clicking the screen first.
  if (!view.locked) rfb?.focus({ preventScroll: true });
};

const render = () => {
  if (!view) {
    $("who").textContent = "Reconnecting";
    $("what").textContent = "";
    return;
  }
  const { mode, turn, agent } = view;
  const working = agent && Date.now() - agent.at < WORKING_MS;
  const orb = $("avatar");
  orb.className = `orb${turn ? " turn" : working ? " live" : ""}`;
  orb.dataset.agent = mode === "control" && !turn ? "you" : base(turn ? turn.agent : working ? agent.name : "");
  if (turn) {
    $("who").textContent = "Your turn";
    $("what").textContent = "";
  } else if (mode === "control") {
    $("who").textContent = "You have control";
    $("what").textContent = "Agents are waiting";
  } else if (view.elsewhere) {
    $("who").textContent = "Your tab";
    $("what").textContent = "No agent is working here";
  } else if (working) {
    $("who").textContent = agent.name;
    $("what").textContent = agent.text;
  } else {
    $("who").textContent = "Standing by";
    $("what").textContent = "";
  }
  renderTurn();
  announce();
  renderPicker();
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  });
  document.body.classList.toggle("in-control", !view.locked);
  $("brave-down").hidden = !view.braveDown;
  $("version").textContent = view.staleDays ? `· Brave is ${view.staleDays} days old. Run ridealong update` : `· ${view.version}`;
  renderActivity();
  renderRules();
  if (!turn) document.title = "Ridealong";
};

// In a background tab, the title is the only thing left that can move.
setInterval(() => {
  if (!view?.turn) return;
  renderTurnClock();
  const blink = document.hidden && Math.floor(Date.now() / 1000) % 2;
  document.title = blink ? "● ● ● ● ●" : "Your turn · Ridealong";
}, 1000);

const listen = () => {
  const events = new EventSource("/api/events");
  events.onmessage = (e) => { view = JSON.parse(e.data); applyLock(); render(); };
  events.onerror = () => {
    view = null;
    applyLock();
    render();
    // It retries by itself, except after an error page from a proxy.
    if (events.readyState === EventSource.CLOSED) setTimeout(listen, 2000);
  };
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
const answerTurn = (blocked) => {
  $("done").disabled = true;
  post("/api/done", { id: view?.turn?.id, blocked }).catch(() => { $("done").disabled = false; });
};
$("done").addEventListener("click", () => answerTurn(false));
$("turn-block").addEventListener("click", () => answerTurn(true));

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
$("restart-brave").addEventListener("click", () => post("/api/brave/restart"));
$("send-clipboard").addEventListener("click", () => rfb?.clipboardPasteFrom($("clipboard").value));

// Phones have no keyboard for a canvas, so a 2FA code goes in through a real field.
const typeInto = (text) => {
  if (!rfb || rfb.viewOnly) return;
  for (const c of text) rfb.sendKey(c === "\n" ? KeyTable.XK_Return : keysyms.lookup(c.codePointAt(0)), null);
};
$("type-clipboard").addEventListener("click", () => typeInto($("clipboard").value));
$("typer").addEventListener("submit", (e) => {
  e.preventDefault();
  typeInto($("typer-text").value);
  $("typer-text").value = "";
});

const NOTIFY_OK = "Notification" in window && window.isSecureContext;
const refreshNotifications = bind("notifications", "notifications", () => {
  if (!settings.notifications) return void unsubscribe();
  Notification.requestPermission().then((answer) => {
    if (answer !== "granted") { settings.notifications = false; save(); refreshNotifications(); }
    else subscribe();
    $("notifications-hint").hidden = answer === "granted";
    $("notifications-hint").textContent = "Your browser blocked notifications for this site.";
  });
});
bind("sound", "sound", () => {});
nudge();
// Keeps the server's copy current: browsers rotate subscriptions now and then.
if (NOTIFY_OK && settings.notifications && Notification.permission === "granted") subscribe();
if (!NOTIFY_OK) {
  $("notifications").disabled = true;
  $("notifications").checked = false;
  $("notifications-hint").hidden = false;
  $("notifications-hint").textContent = "Needs the HTTPS link, and a browser that supports them.";
}

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
