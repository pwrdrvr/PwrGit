// Opt-in investigation, shared by Vitest and the standalone natural-EOF probe.
// Raw Trace2 stays in a private temporary directory, never the upload directory.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const hash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
const keys = ["core.fsmonitor", "core.hookspath", "core.attributesfile", "core.pager", "core.untrackedcache",
  "filter.lfs.process", "filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.required", "maintenance.auto", "gc.auto"];
const knownNames = new Set(["git", "git.exe", "git-lfs", "git-lfs.exe", "node", "node.exe", "sh", "sh.exe",
  "bash", "bash.exe", "cmd.exe", "ssh", "ssh.exe", "branch", "hook", "pager", "?", "_run_shell_alias_",
  "post-checkout", "pre-commit", "post-commit", "reference-transaction", "post-merge", "core", "git-remote-https.exe",
  "fetch", "clone", "upload-pack", "index-pack", "pack-objects", "unpack-objects", "rev-list", "maintenance", "git-upload-pack"]);
function safeName(value) {
  const base = String(value).replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  return knownNames.has(base) ? base : `other:${hash(value)}`;
}
function sanitizeTrace(row) {
  if (!row || typeof row !== "object") return null;
  if (!["version", "start", "cmd_path", "cmd_ancestry", "cmd_name", "child_start", "child_exit", "child_ready",
    "exit", "atexit", "exec", "exec_result", "def_param"].includes(row.event)) return null;
  const result = { event: row.event };
  if (row.event === "version" && typeof row.exe === "string") result.gitVersion = row.exe.match(/^\d+\.\d+\.\d+/)?.[0] ?? "unknown";
  if (typeof row.sid === "string") {
    result.sessionId = hash(row.sid);
    result.sessionPids = [...row.sid.matchAll(/-P([0-9a-f]+)/gi)].map(match => parseInt(match[1], 16));
  }
  if (typeof row.time === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(row.time)) result.utc = row.time;
  for (const key of ["child_id", "pid", "code", "t_abs", "t_rel", "exec_id"]) {
    if (typeof row[key] === "number" && Number.isFinite(row[key])) result[key] = row[key];
  }
  if (typeof row.use_shell === "boolean") result.use_shell = row.use_shell;
  for (const key of ["name", "child_class", "hook_name", "exe"]) if (typeof row[key] === "string") result[key] = safeName(row[key]);
  if (typeof row.path === "string") {
    result.imageId = hash(row.path.toLowerCase().replaceAll("\\", "/"));
    result.binary = safeName(row.path);
    const layout = row.path.replaceAll("\\", "/").match(/\/Git\/(cmd|bin|mingw64\/bin)\/git\.exe$/i);
    if (layout) result.gitInstallationPath = `Git/${layout[1].toLowerCase()}/git.exe`;
  }
  if (Array.isArray(row.ancestry)) result.ancestry = row.ancestry.slice(0, 16).map(safeName);
  if (Array.isArray(row.argv)) {
    result.argumentCount = row.argv.length;
    result.argvId = hash(JSON.stringify(row.argv));
    result.executable = safeName(row.argv[0]);
  }
  if (row.event === "def_param") {
    const key = String(row.param).toLowerCase();
    if (!keys.includes(key)) return null;
    result.key = key;
    const value = String(row.value);
    result.value = /^(true|false|0|1)$/i.test(value) ? value.toLowerCase() : `redacted:${hash(value)}`;
    if (["system", "global", "local", "worktree", "command"].includes(row.scope)) result.scope = row.scope;
  }
  return result;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let active;

class OwnershipSession {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.directory = fs.mkdtempSync(path.join(directory, `ownership-${process.pid}-`));
    this.privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pwrgit-private-trace-"));
    this.calls = [];
    this.context = {};
    this.sequence = 0;
    this.closed = false;
  }
  emit(row) {
    try { fs.appendFileSync(path.join(this.directory, "ownership.jsonl"), `${JSON.stringify({
      schema: 1, workerPid: process.pid, monotonicMs: performance.now(), utc: new Date().toISOString(), ...row
    })}\n`); } catch { /* Diagnostics cannot change Git completion. */ }
  }
  async start() {
    this.emit({ event: "ownership-session", platform: process.platform, nodeVersion: process.version, requestedConfigKeys: keys });
    const exe = process.env.PWRGIT_PIPE_OBSERVER_EXE;
    if (process.platform !== "win32" || !exe) {
      this.emit({ event: "native-observer-unavailable", reason: process.platform === "win32" ? "not-prepared" : "windows-only" });
      return;
    }
    try {
      this.observer = spawn(exe, [String(process.pid), this.directory, exe], { stdio: "ignore", windowsHide: true });
      this.observer.on("error", () => this.emit({ event: "native-observer-error" }));
      this.observer.once("exit", (code, signal) => this.emit({ event: "native-observer-exit", code, signal }));
      const deadline = performance.now() + 4000;
      while (!fs.existsSync(path.join(this.directory, "ready")) && performance.now() < deadline && this.observer.exitCode === null) await delay(20);
      this.nativeReady = fs.existsSync(path.join(this.directory, "ready"));
      this.emit({ event: "native-observer-readiness", ready: this.nativeReady, pid: this.observer.pid });
    } catch { this.emit({ event: "native-observer-unavailable", reason: "startup-error" }); }
  }
  begin(args, cwd, env, id, controlled = false) {
    const branch = args.length === 2 && args[0] === "branch" && args[1] === "--show-current";
    const transfer = args[0] === "fetch" || args[0] === "clone";
    if (this.closed || (!controlled && !branch && !transfer)) return;
    if (this.calls.length >= 256) {
      if (!this.limited) this.emit({ event: "ownership-call-limit", limit: 256 });
      this.limited = true;
      return;
    }
    const callId = `${process.pid}-${++this.sequence}`;
    const trace = path.join(this.privateDirectory, `${callId}.jsonl`);
    const started = performance.now();
    const context = { ...this.context };
    const call = { callId, id, trace, offset: 0, context };
    this.calls.push(call);
    const emit = row => this.emit({ ...context, callId, diagnosticId: id, elapsedMs: performance.now() - started, ...row });
    const environmentKeysPresent = ["GIT_EXEC_PATH", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_PAGER", "GIT_ATTR_NOSYSTEM", "GIT_LFS_SKIP_SMUDGE"]
      .filter(key => env[key] !== undefined);
    emit({ event: "ownership-call-begin", cwdId: hash(cwd), environmentKeysPresent, argumentCount: args.length,
      exactCommand: controlled ? "controlled-holder-alias" : branch ? ["git", "-C", "<fixture>", "branch", "--show-current"] : undefined,
      command: controlled ? "controlled-alias" : branch ? "branch" : args[0] });
    return {
      callId,
      env: { ...env, GIT_TRACE2_EVENT: trace, GIT_TRACE2_CONFIG_PARAMS: keys.join(",") },
      event: (event, pid, detail = {}) => {
        emit({ event, pid, ...detail });
        if (event === "spawn-requested" && context.targetBranchTest && branch) this.request(callId, "spawn", pid);
        if (["exit", "settled", "sync-return", "sync-throw", "helper-flush-grace-expired", "natural-close"].includes(event)) this.flush(call);
        if (event === "helper-flush-grace-expired") this.request(callId, "cutoff", pid);
      }
    };
  }
  flush(call) {
    try {
      const size = fs.statSync(call.trace).size;
      const length = Math.min(size, 1024 * 1024);
      if (length <= call.offset) return;
      const buffer = Buffer.alloc(length - call.offset);
      const fd = fs.openSync(call.trace, "r");
      try { fs.readSync(fd, buffer, 0, buffer.length, call.offset); } finally { fs.closeSync(fd); }
      const content = buffer.toString();
      const end = content.lastIndexOf("\n");
      if (end < 0) return;
      call.offset += Buffer.byteLength(content.slice(0, end + 1));
      for (const line of content.slice(0, end).split("\n").slice(0, 2048)) {
        try {
          const trace = sanitizeTrace(JSON.parse(line));
          if (trace) this.emit({ ...call.context, event: "trace2", callId: call.callId, diagnosticId: call.id, trace });
        } catch { this.emit({ event: "trace2-invalid-record", callId: call.callId }); }
      }
      if (size > length) this.emit({ event: "trace2-size-limit", callId: call.callId });
    } catch { /* Git may not have created the trace file yet. */ }
  }
  request(callId, phase, pid = 0) {
    if (!this.nativeReady || this.closed) return;
    try {
      // Rename publishes a complete request to the independent native reader.
      const name = path.join(this.directory, `request-${++this.sequence}`);
      fs.writeFileSync(`${name}.tmp`, `${callId}\t${phase}\t${pid || 0}`);
      fs.renameSync(`${name}.tmp`, name);
    } catch { this.emit({ event: "handle-request-unavailable", callId, phase }); }
  }
  async inspect(callId, phase, pid = 0) {
    this.request(callId, phase, pid);
    if (!this.nativeReady) return;
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      try {
        const lines = fs.readFileSync(path.join(this.directory, "windows-processes.jsonl"), "utf8").trim().split("\n");
        if (lines.slice(-8).some(line => { const row = JSON.parse(line); return row.callId === callId && row.phase === phase; })) return;
      } catch { }
      await delay(20);
    }
    this.emit({ event: "handle-response-deadline", callId, phase });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (active === this) active = undefined;
    for (const call of this.calls) this.flush(call);
    if (this.observer) {
      try { fs.writeFileSync(path.join(this.directory, "stop"), "stop"); } catch { }
      const deadline = performance.now() + 3000;
      while (this.observer.exitCode === null && this.observer.signalCode === null && performance.now() < deadline) await delay(20);
      if (this.observer.exitCode === null && this.observer.signalCode === null) {
        this.emit({ event: "native-observer-cleanup-deadline" });
        this.observer.kill(); // Only our independent observer, never an observed Git.
      }
    }
    try { fs.rmSync(this.privateDirectory, { recursive: true, force: true }); }
    catch { this.emit({ event: "private-trace-cleanup-unavailable" }); }
    this.emit({ event: "ownership-session-closed", calls: this.calls.length });
  }
}
async function startOwnership(directory) {
  const session = new OwnershipSession(directory);
  await session.start();
  active = session;
  return session;
}
function beginOwnership(args, cwd, env, id) {
  try { return active?.begin(args, cwd, env, id); } catch { return undefined; }
}
function prepareWindowsObserver() {
  if (process.platform !== "win32") return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwrgit-pipe-observer-"));
  const exe = path.join(directory, "pipe-observer.exe");
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -Path ${quote(path.join(__dirname, "windows-pipe-observer.cs"))} -ReferencedAssemblies System.dll,System.Management.dll,System.Core.dll -OutputAssembly ${quote(exe)} -OutputType ConsoleApplication`],
    { timeout: 30000, stdio: "pipe", windowsHide: true });
    if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `PWRGIT_PIPE_OBSERVER_EXE=${exe}\n`);
    process.env.PWRGIT_PIPE_OBSERVER_EXE = exe;
    process.stdout.write("Windows process/pipe observer compiled.\n");
  } catch (error) {
    // Missing OS facilities are recorded explicitly by each session. No shell
    // exception text (which can contain paths) is copied into uploaded artifacts.
    const codes = [...new Set(String(error.stderr ?? "").match(/\bCS\d{4}\b/g) ?? [])].slice(0, 8);
    process.stderr.write(`Windows process/pipe observer compilation unavailable; compiler codes: ${codes.join(",") || "none"}.\n`);
  }
}
module.exports = { startOwnership, beginOwnership, sanitizeTrace, prepareWindowsObserver };
