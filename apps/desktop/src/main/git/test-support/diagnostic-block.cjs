// Controlled synchronous Git alias. The test thread cannot return until this
// child observes the independent watchdog's persisted OS sample.
const { readFileSync } = require("node:fs");
const [callsFile, watchdogFile] = process.argv.slice(2);
const records = (file) => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const begin = records(callsFile).findLast((row) => row.event === "call-begin");
if (!begin || begin.execution !== "sync") process.exit(2);
const timer = setInterval(() => {
  try {
    const rows = records(watchdogFile);
    if (rows.some((row) => row.event === "independent-os-process-sample") &&
        rows.some((row) => row.event === "independent-slow-sync-call")) {
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ childPid: process.pid, beginId: begin.id }), () => process.exit(0));
    }
  } catch { /* Journal may not exist yet, or its last append is in progress. */ }
}, 10);
setTimeout(() => process.exit(3), 6000).unref();
