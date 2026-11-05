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
const save = (b) => { if (FILE) fs.writeFileSync(FILE, JSON.stringify(b)); else memory = b; };

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
const newPage = (b, url) => {
  const page = { id: idFor(b.next++), url: url ?? "about:blank" };
  b.pages.push(page);
  current = page.id;
};

// Runs the code the bridge sends, against a page that knows its own CDP target id.
const runCode = async (b, code) => {
  const handle = (p) => ({
    url: () => p.url,
    context: () => ({
      pages: () => b.pages.map(handle),
      newCDPSession: async (page) => ({ send: async () => ({ targetInfo: { targetId: page.id } }), detach: async () => {} }),
    }),
    id: p.id,
  });
  const page = b.pages.find((p) => p.id === current);
  return await new Function(`return (${code})`)()(handle(page));
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "tools/call") return;
  const { name, arguments: args = {} } = msg.params;
  console.error(JSON.stringify({ call: name, action: args.action }));
  const b = load();
  let text;
  if (name === "browser_run_code_unsafe") {
    if (!b.pages.length) newPage(b, undefined);
    tabs(b);
    text = JSON.stringify(await runCode(b, args.code));
  } else if (name === "browser_tabs") {
    const i = args.index ?? b.pages.findIndex((p) => p.id === current);
    if (args.action === "new") newPage(b, args.url);
    else if (args.action === "select") current = b.pages[args.index]?.id ?? current;
    else if (args.action === "close") {
      b.pages.splice(i, 1);
      current = b.pages[Math.min(i, b.pages.length - 1)]?.id ?? null;
    }
    text = `did ${name}\n${tabs(b)}`;
  } else if (name === "browser_navigate") {
    if (!b.pages.length) newPage(b, undefined);
    tabs(b);
    b.pages.find((p) => p.id === current).url = args.url;
    text = `did ${name}`;
  } else if (name === "browser_snapshot" && args.saved) {
    // Like Playwright with a client whose root is the shared folder's parent.
    text = `- [Snapshot](shared/${args.saved})\nSaved to "shared/${args.saved}"`;
  } else {
    text = `did ${name}`;
  }
  save(b);
  const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }) + "\n");
  setTimeout(answer, name === "browser_wait_for" ? Number(args.time) * 1000 : 0);
});
