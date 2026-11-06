// Stands in for @playwright/mcp: answers every tool call, slowly for browser_wait_for.
//
// It models pages like the real one. FAKE_BROWSER names a JSON file that every fake
// process shares, like sessions sharing one Brave: { pages: [{ id, url }], next }.
// Each process has its own "current" page, and when the current one closes it moves
// to its neighbour in the shared list, which may belong to another session.
import fs from "node:fs";
import { createInterface } from "node:readline";

const FILE = process.env.FAKE_BROWSER;
let memory = { pages: [], next: 0 };
const load = () => (FILE && fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : memory);
// Written through a rename, so another fake process never reads half a file.
const save = (b) => {
  if (!FILE) { memory = b; return; }
  fs.writeFileSync(`${FILE}.${process.pid}`, JSON.stringify(b));
  fs.renameSync(`${FILE}.${process.pid}`, FILE);
};

// The first page keeps the id the older tests expect.
const idFor = (n) => (n === 0 ? "ABCDEF0123456789ABCDEF0123456789" : `ABCDEF0123456789ABCDEF01${n.toString(16).toUpperCase().padStart(8, "0")}`);

let current = null;
const tabs = (b) => {
  if (!b.pages.some((p) => p.id === current)) {
    // Our page went away (we closed it, or the browser did): take the neighbour.
    current = b.pages[0]?.id ?? null;
  }
  return b.pages.map((p, i) => `- ${i}:${p.id === current ? " (current)" : ""} [](${p.url})`).join("\n");
};
const newPage = (b, url, opener) => {
  const page = { id: idFor(b.next++), url: url ?? "about:blank", opener };
  b.pages.push(page);
  current = page.id;
};

// Runs the code the bridge sends, against a page that knows its own CDP target id.
const runCode = async (b, code) => {
  const handle = (p) => ({
    url: () => p.url,
    context: () => ({
      pages: () => b.pages.map(handle),
      newCDPSession: async (page) => ({ send: async () => ({ targetInfo: { targetId: page.id, openerId: page.opener } }), detach: async () => {} }),
    }),
    id: p.id,
    opener: p.opener,
  });
  const page = b.pages.find((p) => p.id === current);
  return await new Function(`return (${code})`)()(handle(page));
};

// Another session acting on the shared browser at the worst moment. A test writes
// ${FAKE_BROWSER}.race as { kind, times }. For "insert" and "remove", each time the
// bridge reads the page list (the code with "openerId") the browser then changes under
// it, so the index it just read is stale: "insert" puts a foreign window first,
// "remove" closes the first foreign one. "flaky" makes the next reads of the current
// page's id fail, like a page that is closing.
const race = (code) => {
  if (!FILE || !fs.existsSync(`${FILE}.race`)) return null;
  const r = JSON.parse(fs.readFileSync(`${FILE}.race`, "utf8"));
  const listing = String(code).includes("openerId");
  const reading = !listing && String(code).includes("getTargetInfo");
  if (!r.times || (r.kind === "listerr" ? code !== "getTargetInfo-list" : code === "getTargetInfo-list" || (r.kind === "flaky" ? !reading : !listing))) return null;
  r.times -= 1;
  fs.writeFileSync(`${FILE}.race`, JSON.stringify(r));
  return r.kind;
};

const lock = async () => {
  if (!FILE) return () => {};
  for (;;) {
    try {
      const fd = fs.openSync(`${FILE}.lock`, "wx");
      fs.closeSync(fd);
      return () => fs.rmSync(`${FILE}.lock`, { force: true });
    } catch (e) {
      // The test removed the browser's folder: nothing left to wait for.
      if (e.code !== "EEXIST") return () => {};
      // A holder that was killed leaves its lock behind. No call holds it this long,
      // so take it over instead of waiting forever.
      try {
        if (Date.now() - fs.statSync(`${FILE}.lock`).mtimeMs > 5000) fs.rmSync(`${FILE}.lock`, { force: true });
      } catch { /* released meanwhile */ }
      await new Promise((r) => setTimeout(r, 2));
    }
  }
};

// When the bridge goes away (ended, or killed before it could end us), so do we.
// Without this, a fake waiting on a lock outlives its test and spins for good.
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }) + "\n");
  }
  if (msg.method !== "tools/call") return;
  const { name, arguments: args = {} } = msg.params;
  console.error(JSON.stringify({ call: name, action: args.action, slowly: args.slowly, paths: args.paths, filename: args.filename }));
  // Like 0.0.84 for a URL that downloads: an error with the URL in its log, and the
  // file saved a moment later in our working directory. "also" saves a second file.
  if (name === "browser_navigate" && /\/(download|failed)\b/.test(args.url)) {
    const url = new URL(args.url);
    if (url.pathname === "/download") {
      for (const file of [url.searchParams.get("name"), url.searchParams.get("also")].filter(Boolean)) {
        setTimeout(() => fs.writeFileSync(file, "a,b\n"), 100);
      }
    }
    const error = url.pathname === "/download" ? "Download is starting" : "net::ERR_CONNECTION_REFUSED";
    const text = `### Error\nError: page.goto: ${error}\nCall log:\n  - navigating to "${args.url}", waiting until "domcontentloaded"`;
    return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text }] } }) + "\n");
  }
  // One call at a time across fake processes, like one browser serving them in turn.
  const unlock = await lock();
  let b;
  let text;
  let isError = false;
  try {
  b = load();
  if (!b.pages.length && (name === "browser_run_code_unsafe" || name === "browser_navigate")) newPage(b, undefined);
  tabs(b);
  const actedOn = b.pages.find((p) => p.id === current)?.url;
  if (name === "browser_run_code_unsafe") {
    const kind = race(args.code);
    if (kind === "flaky") {
      isError = true;
      text = "### Error\nError: page.evaluate: Target page, context or browser has been closed";
    } else {
      text = String(args.code).includes("page.url()") ? '"https://secure.example/"' : JSON.stringify(await runCode(b, args.code));
    }
    if (kind === "insert") b.pages.unshift({ id: idFor(b.next++), url: `https://foreign.test/${b.next}` });
    if (kind === "remove") b.pages.splice(b.pages.findIndex((p) => p.url.startsWith("https://foreign.test/")), 1);
  } else if (name === "browser_tabs") {
    const i = args.index ?? b.pages.findIndex((p) => p.id === current);
    if (args.action === "new") newPage(b, args.url);
    else if (args.action === "select") current = b.pages[args.index]?.id ?? current;
    else if (args.action === "close") {
      b.pages.splice(i, 1);
      current = b.pages[Math.min(i, b.pages.length - 1)]?.id ?? null;
    }
    text = `### Result\n${tabs(b)}`;
    // A window another session is closing makes the list of every tab fail.
    if (args.action === "list" && race("getTargetInfo-list") === "listerr") {
      isError = true;
      text = "### Error\nError: browserBackend.callTool: Target page, context or browser has been closed";
    }
  } else if (name === "browser_navigate") {
    if (!b.pages.length) newPage(b, undefined);
    tabs(b);
    b.pages.find((p) => p.id === current).url = args.url;
    text = `did ${name}`;
    // Like the real one, answers carry the list of every tab in the browser.
    if (FILE) text += `\n### Open tabs\n${tabs(b)}`;
  } else if (name === "browser_click" && args.popup) {
    // A click that opens a page from the current one (target=_blank, window.open).
    tabs(b);
    const from = current;
    newPage(b, args.popup, from);
    current = from;
    text = `did ${name}`;
    if (FILE) text += `\n### Open tabs\n${tabs(b)}`;
  } else if (name === "browser_snapshot" && args.saved) {
    // Like Playwright with a client whose root is the shared folder's parent.
    text = `- [Snapshot](shared/${args.saved})\nSaved to "shared/${args.saved}"`;
  } else {
    text = `did ${name}`;
  }
  // Which page each call ran on, for tests that look for calls on someone else's page.
  if (FILE && name !== "browser_tabs" && name !== "browser_run_code_unsafe") (b.acted ??= []).push({ name, url: actedOn });
  save(b);
  } finally {
    unlock();
  }
  const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError, content: [{ type: "text", text }] } }) + "\n");
  setTimeout(answer, name === "browser_wait_for" ? Number(args.time) * 1000 : 0);
});
