// Drives the real server over HTTP, the way the viewer and agents do.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createRequire } from "node:module";

const ece = createRequire(import.meta.url)("http_ece");

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const running = [];

const start = async (port, env = {}) => {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, VIEWER_PORT: String(port), VNC_PORT: "1", CDP_PORT: "1", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  running.push(child);
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return `http://127.0.0.1:${port}`;
};

const raw = (base, path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const url = new URL(path, base);
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
    let text = "";
    res.on("data", (c) => { text += c; });
    res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  req.on("error", reject);
  req.end(body);
});

const api = (base) => {
  const call = async (path, body) => {
    const res = await raw(base, path, { method: body ? "POST" : "GET", body: body && JSON.stringify(body) });
    return { status: res.status, ...JSON.parse(res.text || "{}") };
  };
  const view = () => new Promise((resolve) => {
    const req = http.get(`${base}/api/events`, (res) => {
      res.once("data", (chunk) => { req.destroy(); resolve(JSON.parse(String(chunk).slice(6))); });
    });
    req.on("error", () => {});
  });
  const join = async (agent) => (await call("/api/session", { agent })).id;
  return { call, view, join };
};

let base, a;
before(async () => { base = await start(16201); a = api(base); });
after(() => running.forEach((c) => c.kill()));

test("the screen unlocks only for a turn, and Watch stays locked", async () => {
  const id = await a.join("Claude");
  assert.equal((await a.view()).locked, true);
  const { id: turn } = await a.call("/api/handover", { session: id, reason: "2FA code" });
  assert.equal((await a.view()).locked, false);
  await a.call("/api/mode", { mode: "watch" });
  assert.equal((await a.view()).locked, true);
  assert.equal((await a.view()).turn.reason, "2FA code");
  await a.call("/api/mode", { mode: "auto" });
  await a.call("/api/done", { id: turn });
  assert.equal((await a.view()).locked, true);
  await a.call("/api/session/end", { id });
});

test("a turn says who it's for and when the agent gives up", async () => {
  const id = await a.join("Claude");
  const { id: turn } = await a.call("/api/handover", { session: id, reason: "Captcha", minutes: 5 });
  const { turn: seen, sessions } = await a.view();
  assert.ok(Math.abs(seen.deadline - Date.now() - 300000) < 2000);
  assert.deepEqual(sessions.map((s) => [s.label, s.text, s.needsYou]), [["Claude", "Waiting for you", true]]);
  await a.call("/api/done", { id: turn });
  await a.call("/api/session/end", { id });
});

test("handing back twice can't answer the next agent's request", async () => {
  const one = await a.join("Claude");
  const two = await a.join("Codex");
  const first = await a.call("/api/handover", { session: one, reason: "first" });
  const second = await a.call("/api/handover", { session: two, reason: "second" });
  await a.call("/api/done", { id: first.id });
  await a.call("/api/done", { id: first.id });
  assert.equal((await a.view()).turn?.id, second.id);
  await a.call("/api/done", { id: second.id });
  await a.call("/api/session/end", { id: one });
  await a.call("/api/session/end", { id: two });
});

test("an agent can tell an answer from a viewer that lost its request", async () => {
  const id = await a.join("Hermes");
  const asked = await a.call("/api/handover", { session: id, reason: "x" });
  await a.call("/api/done", { id: asked.id });
  assert.deepEqual(await a.call(`/api/handover/wait?id=${asked.id}`), { status: 200, done: true, blocked: false, lost: false });
  assert.deepEqual(await a.call("/api/handover/wait?id=123"), { status: 200, done: false, blocked: false, lost: true });
});

test("a stopped wait is shown in the activity list", async () => {
  const id = await a.join("Gemini");
  const { id: turn } = await a.call("/api/handover", { session: id, reason: "y" });
  await a.call("/api/handover/cancel", { id: turn });
  const { activity, turn: open } = await a.view();
  assert.equal(open, null);
  assert.equal(activity[0].text, "Stopped waiting for you");
});

test("sessions keep unique labels, and a lost one must rejoin", async () => {
  const one = await a.join("Cursor");
  const two = await a.join("Cursor");
  await a.call("/api/activity", { session: one, text: "a" });
  await a.call("/api/activity", { session: two, text: "b" });
  const labels = (await a.view()).sessions.map((s) => s.label);
  assert.ok(labels.includes("Cursor") && labels.includes("Cursor 2"));
  assert.equal((await a.call("/api/session/beat", { id: "nobody" })).status, 404);
});

test("other origins can't change anything", async () => {
  const res = await raw(base, "/api/mode", { method: "POST", headers: { Origin: "https://evil.example" }, body: '{"mode":"control"}' });
  assert.equal(res.status, 403);
  assert.equal((await a.view()).mode, "auto");
});

test("a rebinding domain is refused, and allowed names aren't", async () => {
  const evil = { "Host": "evil.example:16201", Origin: "http://evil.example:16201" };
  assert.equal((await raw(base, "/api/mode", { method: "POST", headers: evil, body: '{"mode":"control"}' })).status, 403);
  assert.equal((await raw(base, "/", { headers: evil })).status, 403);
  const open = await start(16202, { VIEWER_URL: "https://box.tailnet.ts.net:6087/", ALLOWED_HOSTS: "viewer.example.com" });
  for (const Host of ["box.tailnet.ts.net:6087", "viewer.example.com", "127.0.0.1:16202", "localhost:16202"]) {
    assert.equal((await raw(open, "/", { headers: { Host } })).status, 200, Host);
  }
});

test("a token replaces the host check", async () => {
  const locked = await start(16203, { VIEWER_TOKEN: "secret" });
  assert.equal((await raw(locked, "/api/gate")).status, 401);
  assert.equal((await raw(locked, "/api/gate?token=secret", { headers: { Host: "192.168.1.5:6086" } })).status, 200);
});

test("Brave can only be restarted once it stops answering", async () => {
  assert.equal((await a.view()).braveDown, false);
  assert.equal((await raw(base, "/api/health")).status, 200);
});

test("an old image asks for an update", async () => {
  const old = api(await start(16206, { RIDEALONG_BUILT: String(Math.floor(Date.now() / 1000) - 20 * 86400) }));
  assert.equal((await old.view()).staleDays, 20);
  assert.equal((await a.view()).staleDays, 0);
});

test("site rules are tidied, saved and survive a restart", async () => {
  const file = path.join(os.tmpdir(), `ridealong-rules-${process.pid}.json`);
  fs.rmSync(file, { force: true });
  const one = api(await start(16207, { RULES_FILE: file }));
  await one.call("/api/rules", { hosts: ["https://www.PayPal.com/signin", "bank.example", "bank.example", "  "] });
  assert.deepEqual((await one.call("/api/rules")).hosts, ["bank.example", "paypal.com"]);
  running.pop().kill();
  await new Promise((r) => setTimeout(r, 100));
  const two = api(await start(16207, { RULES_FILE: file }));
  assert.deepEqual((await two.view()).rules, ["bank.example", "paypal.com"]);
  fs.rmSync(file, { force: true });
});

test("other origins can't change site rules", async () => {
  const res = await raw(base, "/api/rules", { method: "POST", headers: { Origin: "https://evil.example" }, body: '{"hosts":[]}' });
  assert.equal(res.status, 403);
});

test("an approval can be blocked, and the agent learns it was", async () => {
  const id = await a.join("Claude");
  const { id: turn } = await a.call("/api/handover", { session: id, reason: "x", kind: "approval", host: "paypal.com" });
  assert.equal((await a.view()).turn.kind, "approval");
  await a.call("/api/done", { id: turn, blocked: true });
  assert.deepEqual(await a.call(`/api/handover/wait?id=${turn}`), { status: 200, done: true, blocked: true, lost: false });
  assert.equal((await a.view()).activity[0].text, "Blocked Claude on paypal.com");
  await a.call("/api/session/end", { id });
});

test("activity names its tab, and an answer points at the request it answers", async () => {
  const id = await a.join("Claude");
  await a.call("/api/activity", { session: id, text: "Clicking Save" });
  const { id: turn } = await a.call("/api/handover", { session: id, reason: "x" });
  await a.call("/api/done", { id: turn });
  const [answer, ask, step] = (await a.view()).activity;
  assert.equal(step.session, id);
  assert.deepEqual([ask.session, ask.turn, ask.ask], [id, turn, true]);
  assert.deepEqual([answer.who, answer.answers, answer.session], ["You", turn, id]);
  assert.ok(answer.waited >= 0);
  await a.call("/api/session/end", { id });
});

test("a declined handover says so in the activity list", async () => {
  const id = await a.join("Claude");
  const { id: turn } = await a.call("/api/handover", { session: id, reason: "x" });
  await a.call("/api/done", { id: turn, blocked: true });
  assert.equal((await a.view()).activity[0].text, "Declined");
  await a.call("/api/session/end", { id });
});

test("web push reaches subscribed devices, encrypted, and drops dead ones", async () => {
  const file = path.join(os.tmpdir(), `ridealong-push-${process.pid}.json`);
  fs.rmSync(file, { force: true });
  const device = crypto.createECDH("prime256v1");
  device.generateKeys();
  const auth = crypto.randomBytes(16);
  const got = [];
  let gone = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ridealong-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`], { stdio: "ignore" });
  const service = https.createServer({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({ path: req.url, vapid: String(req.headers.authorization).startsWith("vapid t="), body: Buffer.concat(chunks) });
      res.writeHead(req.url === "/gone" ? 410 : 201);
      res.end();
      if (req.url === "/gone") gone = true;
    });
  }).listen(16209);
  // The fake push service's certificate is self-signed.
  const viewer = api(await start(16208, { PUSH_FILE: file, NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
  const { key } = await viewer.call("/api/push");
  assert.ok(key.length > 80);
  const subscription = (endpoint) => ({ endpoint, keys: { p256dh: device.getPublicKey("base64url"), auth: auth.toString("base64url") } });
  assert.equal((await viewer.call("/api/push/subscribe", { subscription: subscription("http://192.168.1.9/x") })).status, 400);
  await viewer.call("/api/push/subscribe", { subscription: subscription("https://127.0.0.1:16209/live") });
  await viewer.call("/api/push/subscribe", { subscription: subscription("https://127.0.0.1:16209/gone") });
  const id = await viewer.join("Codex");
  await viewer.call("/api/handover", { session: id, reason: "Enter the 2FA code" });
  for (let i = 0; i < 50 && (got.length < 2 || !gone); i++) await new Promise((r) => setTimeout(r, 100));
  const live = got.find((g) => g.path === "/live");
  assert.ok(live.vapid);
  const plain = ece.decrypt(live.body, { version: "aes128gcm", privateKey: device, authSecret: auth.toString("base64url") });
  assert.deepEqual(JSON.parse(plain), { title: "Your turn: Codex", body: "Enter the 2FA code" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await viewer.call("/api/push")).devices, 1);
  service.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a new turn pushes to the notify URL", async () => {
  const got = new Promise((resolve) => {
    const hook = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { res.end(); hook.close(); resolve({ title: req.headers.title, body }); });
    }).listen(16205);
  });
  const notified = api(await start(16204, { NOTIFY_URL: "http://127.0.0.1:16205/topic" }));
  const id = await notified.join("Claude");
  await notified.call("/api/handover", { session: id, reason: "2FA code" });
  assert.deepEqual(await got, { title: "Your turn: Claude", body: "2FA code" });
});
