const { parentPort, workerData } = require("node:worker_threads");
const { appendFileSync } = require("node:fs");
const { execFile } = require("node:child_process");
const now = () => Number(process.hrtime.bigint()) / 1e6;
const { file, workerPid, thresholdMs, processSample } = workerData;
let scope;
let latest;
let stage = "test";
let testReported = false;
let sampled = false;
let sampler;
let stopping = false;
let artifactFailed = false;
const active = new Map();
const reportedCalls = new Set();

function emit(report, context = scope) {
  const row = { schema: 2, observer: "independent-js-thread", workerPid,
    suite: context?.suite, testId: context?.testId, observedMonotonicMs: now(), ...report };
  // Worker stdout is forwarded through the blocked parent. Write directly to
  // a separate artifact before posting the optional human-readable notification.
  try { appendFileSync(file, `${JSON.stringify(row)}\n`); }
  catch {
    if (!artifactFailed) parentPort.postMessage({ event: "watchdog-journal-unavailable" });
    artifactFailed = true;
  }
  parentPort.postMessage(row);
}

function sample(context) {
  if (!processSample || sampled || sampler) return;
  sampled = true;
  const windows = process.platform === "win32";
  const command = windows ? "powershell.exe" : "ps";
  const args = windows
    ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation"]
    : ["-e", "-o", "pid=,ppid=,stat="];
  const started = now();
  sampler = execFile(command, args, { timeout: 1500, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
    const samplerPid = sampler?.pid;
    sampler = undefined;
    const rows = stdout.split(/\r?\n/).flatMap((line) => {
      const match = windows ? /^"(\d+)","(\d+)"$/.exec(line.trim()) : /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>NsElWX-]+)\s*$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), state: match[3] }] : [];
    });
    const wanted = new Set([workerPid]);
    for (let depth = 0; depth < 8; depth++) {
      for (const row of rows) if (wanted.has(row.ppid) && wanted.size < 64) wanted.add(row.pid);
    }
    emit({ event: "independent-os-process-sample", elapsedMs: now() - started,
      status: error ? "unavailable-or-incomplete" : "sampled", samplerPid,
      processes: rows.filter((row) => wanted.has(row.pid)).slice(0, 64),
      limitation: "Numeric ancestry only; a synchronous call exposes no ChildProcess PID or stream events." }, context);
    if (stopping) parentPort.close();
  });
}

function check() {
  if (!scope || stopping) return;
  const observed = now();
  const elapsedMs = observed - scope.monotonicMs;
  const outstanding = [...active.values()].map((call) => ({ ...call,
    pendingForMs: observed - call.monotonicMs }));
  const common = { elapsedMs, stage, aggregate: latest?.aggregate,
    lastRecordAgeMs: observed - (latest?.monotonicMs ?? scope.monotonicMs),
    active: outstanding,
    limitation: "No end record received yet; this is not an observed child exit/stream state." };
  if (!testReported && elapsedMs >= thresholdMs) {
    testReported = true;
    emit({ event: "independent-slow-test", ...common,
      observerLatenessMs: Math.max(0, elapsedMs - thresholdMs) });
    sample(scope);
  }
  for (const call of outstanding) {
    const callThresholdMs = call.thresholdMs ?? thresholdMs;
    if (call.execution !== "sync" || call.pendingForMs < callThresholdMs || reportedCalls.has(call.id)) continue;
    reportedCalls.add(call.id);
    emit({ event: "independent-slow-sync-call", ...common, call,
      observerLatenessMs: Math.max(0, call.pendingForMs - callThresholdMs) });
    sample(scope);
  }
}

const timer = setInterval(check, Math.min(100, Math.max(10, thresholdMs / 5)));
parentPort.on("message", (record) => {
  if (record.event === "stop") {
    stopping = true;
    clearInterval(timer);
    if (sampler) sampler.kill();
    else parentPort.close();
    return;
  }
  if (record.event === "scope-begin") {
    scope = record;
    latest = record;
    stage = "test";
    testReported = false;
    sampled = false;
    active.clear();
    reportedCalls.clear();
    return;
  }
  if (!scope || record.testId !== scope.testId) return;
  latest = record;
  if (record.event === "stage") {
    stage = record.stage;
  } else if (record.event === "call-begin") {
    if (active.size < 128) active.set(record.id, record);
  } else if (record.event === "call-end") {
    active.delete(record.id);
    reportedCalls.delete(record.id);
  } else if (record.event === "scope-end") {
    scope = undefined;
    active.clear();
    reportedCalls.clear();
  }
  // Apply an available end record first, so delayed message processing does
  // not knowingly classify a completed call as still outstanding.
  check();
});
parentPort.postMessage({ event: "ready" });
