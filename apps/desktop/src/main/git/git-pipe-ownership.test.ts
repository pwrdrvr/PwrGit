import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startOwnership, sanitizeTrace } from "./test-support/pipe-ownership.cjs";
import { createSystemGit } from "./test-support/system-git";
import { ownershipMatches } from "./test-support/pipe-ownership-probe.cjs";

describe("pipe ownership evidence", () => {
  it("requires a new pipe, opposite endpoint, known owner and write access together", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwrgit-pipe-match-"));
    const root = (pipeId: string) => ({ pid: process.pid, pipeId, endpoint: "server", writeDataAccess: true });
    const peer = (pipeId: string) => ({ pid: 987, pipeId, endpoint: "client", writeDataAccess: true, queriedBinary: "node.exe" });
    const baseline = [root("old")];
    const after = [root("old"), peer("old"), root("same-end"), { ...peer("same-end"), endpoint: "server" },
      root("no-write"), { ...peer("no-write"), writeDataAccess: false }, root("wrong-owner"), { ...peer("wrong-owner"), pid: 988 },
      root("new-pipe"), peer("new-pipe")];
    try {
      writeFileSync(join(directory, "windows-processes.jsonl"), [
        { event: "pipe-handle-sample", callId: "controlled", phase: "baseline", sampleJson: JSON.stringify({ status: "sampled", handles: baseline }) },
        { event: "pipe-handle-sample", callId: "controlled", phase: "post-exit", sampleJson: JSON.stringify({ handles: after }) }
      ].map(row => JSON.stringify(row)).join("\n"));
      expect(ownershipMatches(directory, "controlled", 987)).toEqual([
        expect.objectContaining({ pipeId: "new-pipe", writerPid: 987, writerBinary: "node.exe", readerPid: process.pid })
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("never treats a missing or partial baseline as evidence that later pipes are new", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwrgit-pipe-partial-"));
    const handles = [{ pid: process.pid, pipeId: "pipe", endpoint: "server" },
      { pid: 987, pipeId: "pipe", endpoint: "client", writeDataAccess: true }];
    const postExit = { callId: "controlled", phase: "post-exit", sampleJsonl: JSON.stringify({ status: "sampled", handles }) };
    try {
      for (const baseline of [null, { event: "pipe-name-query-start" },
        { status: "sampled", handles: [], limited: true }, { status: "sampled", handles: [], nameFailures: 1 }]) {
        writeFileSync(join(directory, "windows-processes.jsonl"), [
          { callId: "controlled", phase: "baseline", sampleJsonl: JSON.stringify(baseline) }, postExit
        ].map(row => JSON.stringify(row)).join("\n"));
        expect(ownershipMatches(directory, "controlled", 987)).toEqual([]);
      }
      writeFileSync(join(directory, "windows-processes.jsonl"), [
        { callId: "controlled", phase: "baseline", sampleJsonl: [
          { event: "inspector-start" }, { status: "sampled", handles: [] }
        ].map(row => JSON.stringify(row)).join("\n") }, postExit
      ].map(row => JSON.stringify(row)).join("\n"));
      expect(ownershipMatches(directory, "controlled", 987)).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("excludes existing root pipe objects without needing their potentially blocking names", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwrgit-pipe-objects-"));
    const baseline = { status: "sampled", identityMode: "kernel-object-id", handles: [
      { pid: process.pid, objectId: "existing", nameStatus: "skipped-baseline-existing-or-nonwriter-pipe" }
    ] };
    const postExit = { status: "sampled", handles: [
      { pid: process.pid, objectId: "existing", pipeId: "old-pipe", endpoint: "server" },
      { pid: 987, objectId: "other-old-end", pipeId: "old-pipe", endpoint: "client", writeDataAccess: true },
      { pid: process.pid, objectId: "new-reader", pipeId: "new-pipe", endpoint: "server" },
      { pid: 987, objectId: "new-writer", pipeId: "new-pipe", endpoint: "client", writeDataAccess: true }
    ] };
    try {
      writeFileSync(join(directory, "windows-processes.jsonl"), [
        { callId: "controlled", phase: "baseline", sampleJsonl: JSON.stringify(baseline) },
        { callId: "controlled", phase: "post-exit", sampleJsonl: JSON.stringify(postExit) }
      ].map(row => JSON.stringify(row)).join("\n"));
      expect(ownershipMatches(directory, "controlled", 987)).toEqual([
        expect.objectContaining({ pipeId: "new-pipe", writerPid: 987, readerPid: process.pid })
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("retains child correlation while excluding raw arguments, paths, config and unknown fields", () => {
    const rows = [
      { event: "child_start", sid: "20260915T010203-P00001234/20260915T010203-P00005678", child_id: 7,
        child_class: "hook", hook_name: "post-checkout", argv: ["/secret/tool", "credential-value"],
        cd: "/private/cwd", env: { TOKEN: "secret-token" }, output: "sensitive output" },
      { event: "child_exit", child_id: 7, pid: 987, code: 0, t_rel: 0.2 },
      { event: "def_param", param: "core.hooksPath", value: "/private/hooks", scope: "global" },
      { event: "def_param", param: "filter.lfs.required", value: "true", scope: "local" },
      { event: "def_param", param: "http.extraHeader", value: "Authorization private" },
      { event: "error", msg: "private error message" }
    ].map(sanitizeTrace);
    expect(rows[0]).toMatchObject({ child_id: 7, child_class: "hook", hook_name: "post-checkout", argumentCount: 2,
      sessionPids: [0x1234, 0x5678] });
    expect(rows[1]).toMatchObject({ child_id: 7, pid: 987, code: 0 });
    expect(rows[2]).toMatchObject({ key: "core.hookspath", scope: "global", value: expect.stringMatching(/^redacted:/) });
    expect(rows[3]).toMatchObject({ key: "filter.lfs.required", value: "true" });
    expect(rows.slice(4)).toEqual([null, null]);
    expect(JSON.stringify(rows)).not.toMatch(/secret|private|credential|sensitive|Authorization/);
  });

  it("traces the real branch helper, preserves its output, and removes private traces on close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pwrgit-ownership-test-"));
    const session = await startOwnership(directory);
    try {
      execFileSync("git", ["-C", directory, "init", "-b", "main"], { cwd: tmpdir(), stdio: "ignore" });
      const result = await createSystemGit()(["branch", "--show-current"], directory);
      expect(result).toMatchObject({ ok: true, value: { exitCode: 0, stdout: "main\n", stderr: "" } });
      await session.close();
      const lines = readFileSync(join(session.directory, "ownership.jsonl"), "utf8").trim().split("\n");
      const rows = lines.map(line => JSON.parse(line));
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "ownership-call-begin", exactCommand: ["git", "-C", "<fixture>", "branch", "--show-current"] }),
        expect.objectContaining({ event: "trace2", trace: expect.objectContaining({ event: "cmd_name", name: "branch" }) }),
        expect.objectContaining({ event: "trace2", trace: expect.objectContaining({ event: "exit", code: 0 }) }),
        expect.objectContaining({ event: "settled" }),
        expect.objectContaining({ event: "ownership-session-closed", calls: 1 })
      ]));
      expect(rows.filter(row => row.trace?.event === "child_start")).toEqual([]);
      expect(lines.join("\n")).not.toContain(directory);
      expect(existsSync(session.privateDirectory)).toBe(false);
      expect(session.begin(["branch", "--show-current"], directory, process.env)).toBeUndefined();
    } finally { await session.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 15000);

  it("records actual Git alias child_start and child_exit without exposing the alias", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pwrgit-ownership-child-"));
    const session = await startOwnership(directory);
    const quote = (value: string): string => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    const alias = `!${quote(process.execPath)} -e ${quote("process.exit(0)")}`;
    const args = ["-c", `alias.diagnostic-child=${alias}`, "diagnostic-child"];
    try {
      const call = session.begin(args, tmpdir(), process.env, undefined, true)!;
      execFileSync("git", args, { cwd: tmpdir(), env: call.env, stdio: "ignore" });
      call.event("exit");
      await session.close();
      const text = readFileSync(join(session.directory, "ownership.jsonl"), "utf8");
      const traces = text.trim().split("\n").map(line => JSON.parse(line).trace).filter(Boolean);
      // Git first attempts an external git-diagnostic-child executable (-1
      // means spawn failed), then invokes the configured shell alias.
      const start = traces.find(row => row.event === "child_start" && row.use_shell === true);
      expect(start).toBeDefined();
      expect(traces).toEqual(expect.arrayContaining([expect.objectContaining({ event: "child_exit", child_id: start.child_id, code: 0, pid: expect.any(Number) })]));
      expect(text).not.toContain(alias);
      expect(text).not.toContain("process.exit");
    } finally { await session.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 15000);
});
