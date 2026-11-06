// Stands in for an agent CLI (claude, codex, agy...): logs its arguments.
import fs from "node:fs";
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ client: process.env.FAKE_NAME, args: process.argv.slice(2) }) + "\n");
