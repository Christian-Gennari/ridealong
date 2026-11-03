// Stands in for @playwright/mcp: answers every tool call, slowly for browser_wait_for.
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "tools/call") return;
  const { name, arguments: args = {} } = msg.params;
  console.error(JSON.stringify({ call: name, action: args.action }));
  const text = name === "browser_run_code_unsafe" ? '"ABCDEF0123456789ABCDEF0123456789"' : `did ${name}`;
  const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }) + "\n");
  setTimeout(answer, name === "browser_wait_for" ? Number(args.time) * 1000 : 0);
});
