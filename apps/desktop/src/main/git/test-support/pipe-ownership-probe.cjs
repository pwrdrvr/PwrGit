// A separate, finite experiment. Unlike system-git.ts, this waits for natural
// close; it does not alter the real test helper's existing 250ms drain policy.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { startOwnership, prepareWindowsObserver } = require("./pipe-ownership.cjs");
const quote = value => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function records(file) {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}
function ownershipMatches(directory, callId, holderPid) {
  const rows = records(path.join(directory, "windows-processes.jsonl"));
  const parse = phase => {
    try { return JSON.parse(rows.find(row => row.callId === callId && row.phase === phase)?.sampleJson).handles ?? []; }
    catch { return []; }
  };
  const before = new Set(parse("baseline").filter(row => row.pid === process.pid).map(row => row.pipeId));
  const after = parse("post-exit");
  const readers = after.filter(row => row.pid === process.pid && row.pipeId && row.endpoint && !before.has(row.pipeId));
  return readers.flatMap(reader => after.filter(writer => writer.pid === holderPid && writer.pipeId === reader.pipeId &&
    writer.writeDataAccess && writer.endpoint && writer.endpoint !== reader.endpoint).map(writer => ({ pipeId: reader.pipeId,
    readerPid: reader.pid, readerHandle: reader.handle, writerPid: writer.pid, writerHandle: writer.handle,
    readerEndpoint: reader.endpoint, writerEndpoint: writer.endpoint, writerBinary: writer.queriedBinary,
    writerImageId: writer.imageId, writerCreationUtc: writer.queriedCreationUtc })));
}

async function runProbe(directory, count = 64) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pwrgit-natural-eof-"));
  const session = await startOwnership(directory);
  const results = [];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { cwd: os.tmpdir(), env, stdio: "pipe", timeout: 15000 });
  const configure = cwd => { git(cwd, ["config", "user.name", "Diagnostic Fixture"]); git(cwd, ["config", "user.email", "fixture@example.invalid"]); };
  const commit = (cwd, name) => {
    fs.writeFileSync(path.join(cwd, name), `${name}\n`);
    git(cwd, ["add", name]); git(cwd, ["commit", "-m", name]);
  };
  async function observe(args, cwd, label, options = {}) {
    session.context = { probe: label, handleInspectionRequested: !!options.inspect, nativeObserverReady: !!session.nativeReady };
    const call = session.begin(args, cwd, env, undefined, !!options.holder);
    assert(call, "probe call must be instrumented");
    if (options.inspect) await session.inspect(call.callId, "baseline");
    const started = performance.now();
    const events = [];
    const bytes = { stdout: 0, stderr: 0 };
    const lastActivityMs = { stdout: null, stderr: null };
    let exitMs, holderPid, lateTimer, releaseTimer, inspection;
    const child = spawn("git", ["-C", cwd, ...args], { cwd: os.tmpdir(), env: call.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const event = (name, detail = {}) => {
      const elapsedMs = performance.now() - started;
      events.push({ event: name, elapsedMs, ...detail });
      call.event(name, child.pid, { probeElapsedMs: elapsedMs, ...detail });
    };
    const state = () => Object.fromEntries(["stdout", "stderr"].map(name => [name, {
      readableEnded: child[name].readableEnded, destroyed: child[name].destroyed,
      readableLength: child[name].readableLength, readableFlowing: child[name].readableFlowing,
      bytes: bytes[name], lastActivityMs: lastActivityMs[name]
    }]));
    const result = await new Promise(resolve => {
      // Only this diagnostic experiment owns a finite deadline. Deadline
      // results are explicitly excluded from natural-EOF measurements.
      const deadline = setTimeout(() => {
        event("probe-deadline", { timerLatenessMs: performance.now() - started - 10000, streams: state() });
        child.kill(); child.stdout.destroy(); child.stderr.destroy();
      }, 10000);
      child.once("spawn", () => event("spawn"));
      child.on("error", () => event("child-error"));
      for (const name of ["stdout", "stderr"]) {
        child[name].on("data", chunk => { bytes[name] += chunk.length; lastActivityMs[name] = performance.now() - started; });
        for (const kind of ["end", "close", "error"]) child[name].on(kind, () => event(`${name}-${kind}`));
      }
      child.once("exit", (code, signal) => {
        exitMs = performance.now() - started;
        if (options.holder) holderPid = Number(fs.readFileSync(options.ready, "utf8"));
        event("exit", { code, signal, holderPid });
        lateTimer = setTimeout(() => {
          event("post-exit-pending", { timerLatenessMs: performance.now() - started - exitMs - 250, streams: state(),
            exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed });
          if (options.inspect) inspection = session.inspect(call.callId, "post-exit", holderPid ?? child.pid);
        }, 250);
        if (options.holder) releaseTimer = setTimeout(() => {
          event("fixture-release", { holderPid });
          fs.writeFileSync(options.release, "release");
        }, 1800);
      });
      child.once("close", (code, signal) => {
        clearTimeout(deadline); clearTimeout(lateTimer); clearTimeout(releaseTimer);
        const natural = !events.some(row => row.event === "probe-deadline");
        event(natural ? "natural-close" : "forced-probe-close", { code, signal, streams: state() });
        resolve({ label, callId: call.callId, pid: child.pid, holderPid, natural, code, signal,
          elapsedMs: performance.now() - started, postExitMs: exitMs === undefined ? null : performance.now() - started - exitMs,
          bytes, handleInspectionRequested: !!options.inspect, nativeObserverReady: !!session.nativeReady, events });
      });
    });
    await inspection;
    results.push(result);
    session.emit({ event: "probe-result", ...result });
    assert(result.natural && result.code === 0, "probe did not finish naturally and successfully");
    if (options.holder) {
      assert(result.events.some(row => row.event === "post-exit-pending"), "holder must retain pipes past diagnostic trigger");
      assert(result.events.some(row => row.event === "fixture-release"), "EOF must follow the fixture release");
      const matches = options.inspect ? ownershipMatches(session.directory, call.callId, holderPid) : [];
      session.emit({ event: "controlled-ownership-result", callId: call.callId, holderPid, matches,
        status: matches.length ? "opposite-pipe-endpoints-in-known-holder" : "ownership-not-established",
        timing: options.inspect && session.nativeReady ? "handle-duplication-may-extend-lifetime" : "no-handle-inspection" });
    }
  }
  try {
    // The plain-text merge history from remote.test.ts's implicated case.
    git(fixture, ["init", "--bare", "-b", "main", "origin.git"]);
    git(fixture, ["clone", "origin.git", "local"]);
    const local = path.join(fixture, "local"); configure(local); commit(local, "base.txt"); git(local, ["push", "-u", "origin", "main"]);
    git(fixture, ["clone", "origin.git", "remote"]);
    const remote = path.join(fixture, "remote"); configure(remote); commit(remote, "shared.txt"); git(remote, ["push"]);
    git(local, ["fetch", "origin"]); git(local, ["merge", "--no-ff", "origin/main", "-m", "merge fixture"]);
    commit(remote, "later.txt"); git(remote, ["push"]);
    for (let i = 0; i < count; i++) await observe(["branch", "--show-current"], local, "plain-merge-history-branch");
    for (const inspect of [false, true]) {
      const ready = path.join(fixture, `ready-${inspect}`), release = path.join(fixture, `release-${inspect}`);
      const alias = `!${[process.execPath, path.join(__dirname, "pipe-holder.cjs"), "launcher", ready, release].map(quote).join(" ")}`;
      try { await observe(["-c", `alias.diagnostic-holder=${alias}`, "diagnostic-holder"], local,
        "controlled-detached-holder", { holder: true, inspect, ready, release }); }
      finally { fs.writeFileSync(release, "release"); }
    }
    // Give pre-registered WMI callbacks a bounded window to persist stop events.
    await delay(300);
    session.emit({ event: "probe-summary", branchCalls: count,
      branchPendingPast250ms: results.filter(row => row.label === "plain-merge-history-branch" && row.events.some(e => e.event === "post-exit-pending")).length,
      maxBranchPostExitMs: Math.max(...results.filter(row => row.label === "plain-merge-history-branch").map(row => row.postExitMs)) });
    return { directory: session.directory, results };
  } finally {
    await session.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
if (require.main === module) {
  if (process.argv.includes("--prepare")) prepareWindowsObserver();
  else runProbe(process.env.PWRGIT_GIT_DIAGNOSTICS_DIR ?? path.join(process.cwd(), "test-results", "git-diagnostics"))
    .then(({ results }) => process.stdout.write(`Natural EOF probe: ${results.length} commands completed.\n`))
    .catch(() => { process.stderr.write("Natural EOF diagnostic probe failed; see bounded lifecycle artifact.\n"); process.exitCode = 1; });
}
module.exports = { runProbe, ownershipMatches };
