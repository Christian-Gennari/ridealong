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
      if (env.FAKE_BROWSER && path === "/json/list") return send(browser().pages.map((p) => ({ id: p.id, type: "page" })));
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
  await a.call("browser_tabs", { action: "close", index: 2 });
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
