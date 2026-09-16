import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { beforeEach, expect } from "vitest";
import { GitTripwire } from "./git-tripwire";

const directory = process.env.PWRGIT_GIT_DIAGNOSTICS_DIR;
const file = directory ? join(directory, `git-${process.pid}-${randomUUID()}.jsonl`) : undefined;
let artifactFailed = false;
beforeEach(context => {
  const suite = basename(expect.getState().testPath ?? "");
  if (!["remote.test.ts", "partial-staging.test.ts", "rebase-assistant.test.ts"].includes(suite)) return;
  const tripwire = new GitTripwire(row => {
    const line = JSON.stringify({ suite, testId: context.task.id, workerPid: process.pid, ...row });
    if (file && directory) {
      try { mkdirSync(directory, { recursive: true }); appendFileSync(file, `${line}\n`); }
      catch {
        if (!artifactFailed) process.stderr.write("[git-tripwire] artifact unavailable\n");
        artifactFailed = true;
      }
    }
    if (row.alert) process.stderr.write(`[git-tripwire] ${line}\n`);
  });
  context.onTestFinished(() => tripwire.finish(context.task.result?.state === "fail"));
});
