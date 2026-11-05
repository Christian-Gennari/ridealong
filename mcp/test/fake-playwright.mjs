// Stands in for @playwright/mcp: answers every tool call, slowly for browser_wait_for.
import fs from "node:fs";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "tools/call") return;
  const { name, arguments: args = {} } = msg.params;
  console.error(JSON.stringify({ call: name, action: args.action }));
  const text = name === "browser_run_code_unsafe" ? '"ABCDEF0123456789ABCDEF0123456789"'
    // Like Playwright with a client whose root is the shared folder's parent.
    : name === "browser_snapshot" && args.saved ? `- [Snapshot](shared/${args.saved})\nSaved to "shared/${args.saved}"`
    : `did ${name}`;
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
  const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }) + "\n");
  setTimeout(answer, name === "browser_wait_for" ? Number(args.time) * 1000 : 0);
});
