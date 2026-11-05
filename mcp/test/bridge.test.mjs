// Drives the real bridge over stdio, with a fake Playwright, viewer and browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";

const BRIDGE = new URL("../ridealong-mcp.mjs", import.meta.url).pathname;
const FAKE = new URL("./fake-playwright.mjs", import.meta.url).pathname;
const TARGET = "ABCDEF0123456789ABCDEF0123456789";

const bridges = [];
const servers = [];
after(() => { bridges.forEach((b) => b.kill()); servers.forEach((s) => s.close()); });

// Each bridge gets its own fake viewer and debugging port, which record every request.
// With env.FAKE_BROWSER set, the debugging port reflects the fake browser's shared pages.
const startBridge = async (env = {}, cwd) => {
  const browser = () => JSON.parse(fs.readFileSync(env.FAKE_BROWSER, "utf8"));
  const edit = (f) => { const b = browser(); f(b); fs.writeFileSync(env.FAKE_BROWSER, JSON.stringify(b)); };
  const seen = [];
  let nextSession = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      seen.push({ path, body: body ? JSON.parse(body) : null });
      const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (path === "/api/session") return send({ id: String(++nextSession), label: "Claude" });
      if (path === "/api/gate") return send({ go: true });
      if (path === "/api/rules") return send({ hosts: [] });
      if (env.FAKE_BROWSER && path === "/json/list") return send(browser().pages.map((p) => ({ id: p.id, type: "page", url: p.url })));
      if (env.FAKE_BROWSER && path.startsWith("/json/close/")) return send(edit((b) => { b.pages = b.pages.filter((p) => p.id !== path.split("/").pop()); }));
      if (env.FAKE_BROWSER && path === "/json/new") return send(edit((b) => b.pages.push({ id: `NEW${b.next++}`, url: "about:blank" })));
      if (path === "/json/list") return send([{ id: TARGET, type: "page" }, { id: "OTHER", type: "page" }]);
      send({});
    });
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const child = spawn(process.execPath, [BRIDGE, "--agent", "Claude", "--", process.execPath, FAKE], {
    env: { PATH: process.env.PATH, RIDEALONG_VIEWER: base, RIDEALONG_CDP: base, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
  });
  bridges.push(child);
  const calls = [];
  createInterface({ input: child.stderr }).on("line", (l) => { try { calls.push(JSON.parse(l)); } catch { /* not ours */ } });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (l) => {
    const msg = JSON.parse(l);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const call = (name, args = {}) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  const count = (path) => seen.filter((x) => x.path === path).length;
  const end = () => child.stdin.end();
  return { call, calls, seen, count, end };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const texts = (answer) => answer.result.content.map((c) => c.text);

test("an idle session gives back its tab and joins again on the next call", async () => {
  const bridge = await startBridge({ RIDEALONG_IDLE_RELEASE_MIN: "0.01" }); // 600 ms
  assert.deepEqual(texts(await bridge.call("browser_navigate", { url: "https://example.com" })), ["did browser_navigate"]);
  const first = bridge.seen.find((x) => x.path === "/api/session/target")?.body.id;
  assert.ok(first);
  await sleep(1200);
  // Its own tab, by id, and nobody else's.
  assert.deepEqual(bridge.seen.filter((x) => x.path.startsWith("/json/close/")).map((x) => x.path), [`/json/close/${TARGET}`]);
  assert.deepEqual(bridge.seen.filter((x) => x.path === "/api/session/end").map((x) => x.body.id), [first]);
  await sleep(200);
  assert.equal(bridge.count("/api/session"), 1, "released sessions don't rejoin on their own");

  const again = await bridge.call("browser_snapshot");
  const [note, answer] = texts(again);
  assert.match(note, /closed your old tab after 0\.01 idle minutes/);
  assert.equal(answer, "did browser_snapshot");
  assert.equal(bridge.count("/api/session"), 2);
  assert.equal(bridge.calls.filter((c) => c.call === "browser_tabs" && c.action === "new").length, 2);
  // The note comes once.
  assert.deepEqual(texts(await bridge.call("browser_snapshot")), ["did browser_snapshot"]);
});

test("a session isn't released while a call is still running", async () => {
  const bridge = await startBridge({ RIDEALONG_IDLE_RELEASE_MIN: "0.01" });
  await bridge.call("browser_navigate", { url: "https://example.com" });
  await bridge.call("browser_wait_for", { time: 1.5 });
  assert.equal(bridge.count("/api/session/end"), 0);
  assert.equal(bridge.seen.filter((x) => x.path.startsWith("/json/close/")).length, 0);
});

test("0 turns the release off", async () => {
  const bridge = await startBridge({ RIDEALONG_IDLE_RELEASE_MIN: "0" });
  await bridge.call("browser_navigate", { url: "https://example.com" });
  await sleep(800);
  assert.equal(bridge.count("/api/session/end"), 0);
});

test("saved files point into the shared folder, whatever the client's root", async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "ridealong-files-"));
  after(() => fs.rmSync(shared, { recursive: true, force: true }));
  fs.writeFileSync(path.join(shared, "page.yml"), "");
  const bridge = await startBridge({}, shared);
  const [text] = texts(await bridge.call("browser_snapshot", { saved: "page.yml" }));
  const file = path.join(fs.realpathSync(shared), "page.yml");
  assert.equal(text, `- [Snapshot](${file})\nSaved to "${file}"`);
});

// Two sessions in one fake browser: the same state file stands for the shared Brave.
const twoSessions = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ridealong-browser-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const FAKE_BROWSER = path.join(dir, "browser.json");
  fs.writeFileSync(FAKE_BROWSER, JSON.stringify({ pages: [], next: 0 }));
  const a = await startBridge({ FAKE_BROWSER });
  const b = await startBridge({ FAKE_BROWSER });
  const urls = () => JSON.parse(fs.readFileSync(FAKE_BROWSER, "utf8")).pages.map((p) => p.url);
  return { a, b, urls };
};

test("new, close, navigate stays in the session's own tabs", async () => {
  const { a, b, urls } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/2" });
  await a.call("browser_tabs", { action: "close" });
  // Playwright's current page is now b's. The next call must not land there.
  await a.call("browser_navigate", { url: "https://a.test/3" });
  assert.deepEqual(urls(), ["https://a.test/3", "https://b.test/1"]);
  await b.call("browser_navigate", { url: "https://b.test/2" });
  assert.deepEqual(urls(), ["https://a.test/3", "https://b.test/2"]);
});

test("closing one of two tabs moves on to the other one", async () => {
  const { a, b, urls } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/2" });
  await a.call("browser_tabs", { action: "close", index: 1 });
  await a.call("browser_navigate", { url: "https://a.test/3" });
  assert.deepEqual(urls(), ["https://a.test/3", "https://b.test/1"]);
});

test("closing the last tab makes the next call open a new one", async () => {
  const { a, b, urls } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  await a.call("browser_tabs", { action: "close" });
  await a.call("browser_navigate", { url: "https://a.test/2" });
  assert.deepEqual(urls().sort(), ["https://a.test/2", "https://b.test/1"]);
});

test("ending a session closes its own tabs, not the current one", async () => {
  const { a, b, urls } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/2" });
  // Playwright's current page is b's when a ends.
  await a.call("browser_tabs", { action: "select", index: 1 });
  a.end();
  await sleep(1200);
  assert.deepEqual(urls(), ["https://b.test/1"]);
});

test("browser_close closes all of the session's tabs by id", async () => {
  const { a, b, urls } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/2" });
  await a.call("browser_close");
  assert.deepEqual(urls(), ["https://b.test/1"]);
});

const listed = (answer) => texts(answer).join("\n").split("\n").filter((l) => /^- \d+:/.test(l));

test("the tab list shows only the session's own tabs, numbered from 0", async () => {
  const { a, b } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/2" });
  await b.call("browser_tabs", { action: "new", url: "https://b.test/2" });
  assert.deepEqual(listed(await a.call("browser_tabs", { action: "list" })), [
    "- 0: [](https://a.test/1)",
    "- 1: (current) [](https://a.test/2)",
  ]);
  // Every other answer with the block is rewritten too.
  const nav = await a.call("browser_navigate", { url: "https://a.test/3" });
  assert.deepEqual(listed(nav), ["- 0: [](https://a.test/1)", "- 1: (current) [](https://a.test/3)"]);
  assert.match(texts(nav).join("\n"), /### Open tabs/);
  assert.deepEqual(listed(await b.call("browser_tabs", { action: "list" })), [
    "- 0: [](https://b.test/1)",
    "- 1: (current) [](https://b.test/2)",
  ]);
});

test("select and close take the session's own index, and refuse one it doesn't have", async () => {
  const { a, b, urls } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/2" });
  // b opens tabs too, so a's tabs are 0, 2 and 4 in the browser but 0, 1, 2 for a.
  await b.call("browser_tabs", { action: "new", url: "https://b.test/2" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/3" });
  const picked = await a.call("browser_tabs", { action: "select", index: 1 });
  assert.deepEqual(listed(picked), [
    "- 0: [](https://a.test/1)",
    "- 1: (current) [](https://a.test/2)",
    "- 2: [](https://a.test/3)",
  ]);
  await a.call("browser_navigate", { url: "https://a.test/2b" });
  assert.ok(urls().includes("https://a.test/2b"));
  assert.ok(urls().includes("https://b.test/1") && urls().includes("https://b.test/2"));

  for (const index of [3, 5, -1]) {
    const refused = await a.call("browser_tabs", { action: "close", index });
    assert.match(texts(refused)[0], /isn't one of your tabs.*numbered 0 to 2/);
  }
  assert.equal(urls().length, 5, "a refused close closes nothing");

  const closed = await a.call("browser_tabs", { action: "close", index: 0 });
  assert.deepEqual(listed(closed), ["- 0: (current) [](https://a.test/2b)", "- 1: [](https://a.test/3)"]);
  assert.ok(!urls().includes("https://a.test/1"));
  assert.ok(urls().includes("https://b.test/1") && urls().includes("https://b.test/2"));
});

test("a page opened by the session's page belongs to it and closes with it", async () => {
  const { a, b, urls } = await twoSessions();
  await a.call("browser_navigate", { url: "https://a.test/1" });
  await b.call("browser_navigate", { url: "https://b.test/1" });
  const clicked = await a.call("browser_click", { element: "link", popup: "https://a.test/popup" });
  assert.deepEqual(listed(clicked), ["- 0: (current) [](https://a.test/1)", "- 1: [](https://a.test/popup)"]);
  // b's page opening a popup doesn't give it to a.
  await b.call("browser_click", { element: "link", popup: "https://b.test/popup" });
  assert.equal(listed(await a.call("browser_tabs", { action: "list" })).length, 2);
  a.end();
  await sleep(1200);
  assert.deepEqual(urls().sort(), ["https://b.test/1", "https://b.test/popup"]);
});

test("browser_tabs new doesn't leave the wrapper's blank tab behind", async () => {
  const { a, urls } = await twoSessions();
  // The agent's first call is browser_tabs new: the blank tab the wrapper claimed was never used.
  const opened = await a.call("browser_tabs", { action: "new", url: "https://a.test/1" });
  assert.deepEqual(urls(), ["https://a.test/1"]);
  assert.deepEqual(listed(opened), ["- 0: (current) [](https://a.test/1)"]);
  // A tab that was used stays.
  await a.call("browser_navigate", { url: "https://a.test/2" });
  await a.call("browser_tabs", { action: "new", url: "https://a.test/3" });
  assert.deepEqual(urls(), ["https://a.test/2", "https://a.test/3"]);
});

test("sessions that open tabs at the same moment each keep their own", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ridealong-browser-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const FAKE_BROWSER = path.join(dir, "browser.json");
  fs.writeFileSync(FAKE_BROWSER, JSON.stringify({ pages: [], next: 0 }));
  // One viewer for all, which refuses a tab a second session asks for.
  const owners = new Map();
  const viewer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const p = req.url.split("?")[0];
      const b = body ? JSON.parse(body) : {};
      const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (p === "/api/session") return send(200, { id: String(owners.size + 1 + Math.random()), label: "Claude" });
      if (p === "/api/gate") return send(200, { go: true });
      if (p === "/api/session/target") {
        if (owners.has(b.target) && owners.get(b.target) !== b.id) return send(409, { taken: true });
        owners.set(b.target, b.id);
      }
      send(200, { hosts: [] });
    });
  });
  servers.push(viewer);
  await new Promise((r) => viewer.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${viewer.address().port}`;
  const cdp = http.createServer((req, res) => {
    const state = JSON.parse(fs.readFileSync(FAKE_BROWSER, "utf8"));
    if (req.url.startsWith("/json/close/")) {
      state.pages = state.pages.filter((p) => p.id !== req.url.split("/").pop());
      fs.writeFileSync(`${FAKE_BROWSER}.cdp`, JSON.stringify(state));
      fs.renameSync(`${FAKE_BROWSER}.cdp`, FAKE_BROWSER);
    }
    const pages = state.pages.map((p) => ({ id: p.id, type: "page", url: p.url }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/json/list") ? pages : {}));
  });
  servers.push(cdp);
  await new Promise((r) => cdp.listen(0, "127.0.0.1", r));
  const cdpBase = `http://127.0.0.1:${cdp.address().port}`;
  const start = async () => {
    const child = spawn(process.execPath, [BRIDGE, "--agent", "Claude", "--", process.execPath, FAKE], {
      env: { PATH: process.env.PATH, RIDEALONG_VIEWER: base, RIDEALONG_CDP: cdpBase, FAKE_BROWSER },
      stdio: ["pipe", "pipe", "pipe"],
    });
    bridges.push(child);
    const waiting = new Map();
    createInterface({ input: child.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
    return (name, args) => new Promise((resolve) => {
      waiting.set(1, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });
  };
  const calls = await Promise.all([1, 2, 3, 4, 5].map(start));
  await Promise.all(calls.map((c, i) => c("browser_tabs", { action: "new", url: `https://s${i}.test/` })));
  const open = () => JSON.parse(fs.readFileSync(FAKE_BROWSER, "utf8")).pages;
  assert.equal(new Set(owners.values()).size, 5, "five sessions, five owners");
  assert.deepEqual(open().map((p) => p.url).sort(), [0, 1, 2, 3, 4].map((i) => `https://s${i}.test/`), "no blank tab left over");
  for (const { id } of open()) assert.ok(owners.has(id), "every open tab has an owner");
  assert.equal(new Set(open().map((p) => owners.get(p.id))).size, 5, "no tab shared");
  await Promise.all(calls.map((c, i) => c("browser_navigate", { url: `https://n${i}.test/` })));
  const urls = JSON.parse(fs.readFileSync(FAKE_BROWSER, "utf8")).pages.map((p) => p.url).sort();
  assert.deepEqual(urls, [0, 1, 2, 3, 4].map((i) => `https://n${i}.test/`));
});
