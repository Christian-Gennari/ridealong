// Stands in for the docker command: logs every call to $FAKE_LOG and answers like a
// healthy Ridealong. `exec -i` echoes its input back, like an MCP server would answer.
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, filesInside: process.env.RIDEALONG_FILES_INSIDE, hostOs: process.env.RIDEALONG_HOST_OS }) + "\n");
const state = process.env.FAKE_STATE;
const isRunning = () => fs.existsSync(state);
if (args[0] === "inspect") {
  const format = args[2];
  if (!isRunning()) process.exit(1);
  if (format.includes("Health")) console.log(format.includes("Status}},") ? "running, healthy" : "healthy");
  else console.log("true");
} else if (args[0] === "compose" && args.includes("up")) {
  fs.writeFileSync(state, "up");
} else if (args[0] === "compose" && args.includes("down")) {
  fs.rmSync(state, { force: true });
} else if (args[0] === "compose" && args.includes("pull")) {
  process.exit(process.env.FAKE_PULL_FAILS ? 1 : 0);
} else if (args[0] === "exec" && args[1] === "-i") {
  process.stdin.pipe(process.stdout);
} else if (args[0] === "exec") {
  console.log(args.at(-1).includes("9222") ? '{"Browser":"Brave/1"}' : '{"ok":true}');
}
