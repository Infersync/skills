#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const model = process.env.INFERSYNC_AIDER_MODEL
  || (process.env.GEMINI_API_KEY ? "gemini/gemini-2.5-flash-lite" : "groq/llama-3.3-70b-versatile");

let task = "";
process.stdin.on("data", (d) => (task += d));
process.stdin.on("end", () => {
  const tmp = mkdtempSync(join(tmpdir(), "aider-"));
  writeFileSync(join(tmp, "task.md"), task);
  // Its histories go to the temp folder: nothing of Aider's own lands in the change.
  const aider = spawn(process.env.AIDER_BIN || "aider", ["--message-file", join(tmp, "task.md"), "--model", model,
    "--yes-always", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore", "--no-check-update",
    "--no-show-model-warnings", "--no-pretty", "--no-stream", "--analytics-disable",
    "--chat-history-file", join(tmp, "chat.md"), "--input-history-file", join(tmp, "input")],
    { shell: process.platform === "win32", windowsHide: true });
  const edited = new Set();
  let failed = "";
  // The first model error, or the rate limit when there is one: it says why.
  const noteError = (line) => { if (/rate limited/i.test(line) || (!failed && /API Error|Response Error/i.test(line))) failed = line.slice(0, 200); };
  let rest = "";
  aider.stdout.on("data", (d) => {
    const lines = (rest + d).split("\n");
    rest = lines.pop();
    for (const line of lines.map((l) => l.trim())) {
      let m;
      if ((m = /^Applied edit to (.+)$/.exec(line))) { edited.add(m[1]); say({ type: "action", tool: "Edit", input: { file_path: m[1] } }); }
      else if ((m = /^Added (.+) to the chat/.exec(line))) say({ type: "action", tool: "Read", input: { file_path: m[1] } });
      else if ((m = /^Running (.+)$/.exec(line))) say({ type: "action", tool: "Bash", input: { command: m[1] } });
      else if ((m = /^Tokens: ([\d.]+)(k?) sent, ([\d.]+)(k?) received/.exec(line) || /^([\d.]+)(k?) ◇ [^↑]*↑ ([\d.]+)(k?) ↓/.exec(line)))
        say({ type: "tokens", in: Math.round(m[1] * (m[2] ? 1000 : 1)), out: Math.round(m[3] * (m[4] ? 1000 : 1)) });
      noteError(line);
      process.stderr.write(line + "\n");
    }
  });
  aider.stderr.on("data", (d) => { String(d).split("\n").forEach(noteError); process.stderr.write(d); });
  aider.on("close", (code) => {
    for (const cache of readdirSync(".").filter((f) => /^\.(aider|cecli)/.test(f))) rmSync(cache, { recursive: true, force: true });
    // The model failed: say so, last on stderr, instead of "changed nothing".
    if (!edited.size && (code !== 0 || failed)) {
      process.stderr.write(`Aider's model failed: ${failed || `exit ${code}`}\n`);
      process.exit(code || 1);
    }
    say({ type: "done", summary: edited.size ? `Aider edited ${[...edited].join(", ")}.` : "Aider changed nothing." });
    process.exit(0);
  });
});
