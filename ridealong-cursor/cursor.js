// Agent Cursor. Playwright sends input straight to the page and never moves the
// X11 pointer, so the page's mouse events and messages from ridealong-mcp
// are the only signs of what an agent is doing. Frames forward both up; the top
// frame draws everything. Pages can post the same messages, so nothing here may
// do more than change what this overlay shows. The viewer switches tabs itself.
(() => {
  const isTop = window === window.top;

  const send = (msg) => {
    if (isTop) handle(msg);
    else window.parent.postMessage({ ridealongFrame: 1, ...msg }, "*");
  };

  const mouse = (kind) => (e) => send({ kind, x: e.clientX, y: e.clientY });
  window.addEventListener("mousemove", mouse("move"), true);
  window.addEventListener("mousedown", mouse("down"), true);
  window.addEventListener("mouseup", mouse("up"), true);

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.ridealong) {
      const { ridealong, ...msg } = d;
      send({ kind: msg.cmd, ...msg });
    } else if (d?.ridealongFrame) {
      const frame = [...document.querySelectorAll("iframe, frame")]
        .find((f) => f.contentWindow === e.source);
      if (!frame) return;
      const r = frame.getBoundingClientRect();
      const { ridealongFrame, ...msg } = d;
      if (typeof msg.x === "number") { msg.x += r.left; msg.y += r.top; }
      if (typeof msg.left === "number") { msg.left += r.left; msg.top += r.top; }
      send(msg);
    }
  });

  if (!isTop) return;

  const ORBS = {
    claude: "radial-gradient(circle at 32% 28%, #ffe0ad, #ff8f45 46%, #dc4a1c 82%, #8a2f15)",
    codex: "radial-gradient(circle at 32% 28%, #d8fff0, #5fe0b5 48%, #16a085 84%, #0b5f55)",
    gemini: "radial-gradient(circle at 32% 28%, #fff0c9, #ffc94d 46%, #e88a1a 84%, #a4520c)",
    cursor: "radial-gradient(circle at 32% 28%, #ffe0ee, #ff8fc0 48%, #d6418f 84%, #8b1d5c)",
    hermes: "radial-gradient(circle at 32% 28%, #eed6ff, #a78bfa 48%, #5f7dff 84%, #3b49c9)",
  };
  const ORB = "radial-gradient(circle at 32% 28%, #f4f2ef, #cfcbc6 60%, #a8a39d)";

  const CSS = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    :host([data-hidden]) { visibility: hidden; }
    .cursor { position: absolute; left: 0; top: 0; opacity: 0; transition: opacity 300ms ease; will-change: transform; }
    .arrow { position: absolute; left: -2px; top: -2px; width: 24px; height: 24px; overflow: visible;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,.28)); transform-origin: 2px 2px; transition: transform 120ms ease; }
    .arrow.pressed { transform: scale(.86); }
    .pill { position: absolute; left: 22px; top: 22px; display: flex; align-items: center; gap: 7px;
      padding: 5px 12px 5px 7px; border-radius: 999px; background: #fff; color: #000; white-space: nowrap;
      font: 400 13px/16px Inter, "Segoe UI", system-ui, -apple-system, sans-serif; letter-spacing: -.005em;
      box-shadow: 0 4px 16px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.06); }
    .pill.flip { left: auto; right: 6px; }
    .pill i { width: 14px; height: 14px; border-radius: 50%; background: var(--accent); }
    .ring { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
      border: 1.5px solid #000; box-shadow: 0 0 0 1px rgba(255,255,255,.7); opacity: 0; box-sizing: border-box; }
  `;
  const HTML = `
    <div class="cursor">
      <div class="ring"></div>
      <svg class="arrow" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M3 2.4 20.6 9.3c.9.35.85 1.6-.06 1.9l-7.3 2.3a1 1 0 0 0-.65.65l-2.3 7.3c-.3.9-1.55.95-1.9.06L1.9 3.5c-.3-.75.35-1.4 1.1-1.1Z"
          fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div class="pill"><i></i><span></span></div>
    </div>`;

  const IDLE_MS = 20000;
  const STORE = "ridealong-cursor"; // per tab, so sessions can't show each other's cursor
  let host, cursor, arrow, pill, pillText, ring;
  let pos = null, agent = "Agent", frame = 0;
  let idleTimer, labelTimer, saveTimer, grouped = false, session = null, viewer = null;

  const mount = () => {
    if (host?.isConnected || !document.documentElement) return;
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("aria-hidden", "true");
      const root = host.attachShadow({ mode: "closed" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      const wrap = document.createElement("div");
      wrap.innerHTML = HTML;
      root.append(...wrap.childNodes);
      cursor = root.querySelector(".cursor");
      arrow = root.querySelector(".arrow");
      pill = root.querySelector(".pill");
      pillText = root.querySelector(".pill span");
      pillText.textContent = agent;
      ring = root.querySelector(".ring");
      paint();
    }
    document.documentElement.append(host);
    if (pos) put(pos.x, pos.y);
  };

  // "Claude 2" gets Claude's orb.
  const paint = () => host?.style.setProperty("--accent", ORBS[agent.toLowerCase().replace(/ \d+$/, "")] ?? ORB);

  const put = (x, y) => { cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`; };

  // A shallow curve, slowing into the target like a hand does.
  const glide = (x, y) => {
    cancelAnimationFrame(frame);
    const from = pos ?? { x, y };
    pos = { x, y };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { sessionStorage.setItem(STORE, JSON.stringify({ pos, agent })); } catch { /* optional */ }
    }, 150);
    const dx = x - from.x, dy = y - from.y, dist = Math.hypot(dx, dy);
    pill?.classList.toggle("flip", x > innerWidth - 300);
    if (dist < 2) return put(x, y);
    const ms = Math.min(420, 140 + dist * 0.35);
    const cx = from.x + dx / 2 - dy * 0.12, cy = from.y + dy / 2 + dx * 0.12;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms), e = 1 - (1 - t) ** 3, u = 1 - e;
      put(u * u * from.x + 2 * u * e * cx + e * e * x, u * u * from.y + 2 * u * e * cy + e * e * y);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const wake = () => {
    cursor.style.opacity = "1";
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { cursor.style.opacity = "0"; }, IDLE_MS);
  };

  const label = (text) => {
    pillText.textContent = text || agent;
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => { pillText.textContent = agent; }, 4000);
  };

  const identify = (name) => {
    if (!name || name === agent) return;
    agent = name;
    paint();
    if (pillText) pillText.textContent = agent;
  };

  const joinGroup = () => {
    if (grouped || agent === "Agent") return;
    grouped = true;
    chrome.runtime.sendMessage({ group: agent, session, viewer }).catch(() => {});
  };

  function handle(m) {
    mount();
    if (!host) return;
    identify(m.agent);
    if (m.session) { session = m.session; viewer = m.viewer; }
    switch (m.kind) {
      case "move":
        glide(m.x, m.y); wake(); break;
      case "down":
        glide(m.x, m.y); wake();
        arrow.classList.add("pressed");
        ring.animate(
          [{ opacity: .7, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.3)" }],
          { duration: 420, easing: "ease-out" });
        break;
      case "up":
        arrow.classList.remove("pressed"); break;
      case "status":
        joinGroup(); wake(); label(m.text);
        if (!pos) glide(innerWidth / 2, innerHeight / 2);
        break;
      case "target":
        joinGroup(); wake(); label(m.text);
        glide(m.left + m.width / 2, m.top + m.height / 2);
        break;
      case "hide": host.setAttribute("data-hidden", ""); break;
      case "show": host.removeAttribute("data-hidden"); break;
    }
  }

  // Carry the cursor across navigations within this tab.
  const restore = () => {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORE)); } catch { /* optional */ }
    if (!saved?.pos) return;
    agent = saved.agent ?? agent;
    pos = saved.pos;
    mount();
    if (host) wake();
  };
  if (document.documentElement) restore();
  else document.addEventListener("readystatechange", restore, { once: true });
})();
