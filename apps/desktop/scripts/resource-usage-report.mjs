import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";

/** Summarize an elapsed window; CPU and child wall time remain separate. */
export function summarizeResources(samples) {
  const sessions = new Map();
  const commands = new Map();
  for (const sample of samples) {
    if (sample.version !== 1) continue;
    const key = `${sample.mainPid}:${sample.sessionStartedAt}`;
    const session = sessions.get(key) ?? {
      mainPid: sample.mainPid, startedAt: sample.sessionStartedAt, samples: 0, hours: 0, mainCpuSeconds: 0,
      rendererCpuSeconds: 0, gpuCpuSeconds: 0, otherCpuSeconds: 0,
      unavailableCpuCounters: 0, gitStarts: 0, peakGit: 0
    };
    session.samples++;
    session.hours += sample.intervalMs / 3_600_000;
    session.peakGit = Math.max(session.peakGit, sample.git.peak);
    for (const process of sample.processes) {
      if (process.cpuSeconds === null) session.unavailableCpuCounters++;
      const field = process.type === "Browser" ? "mainCpuSeconds" :
        process.type === "Tab" ? "rendererCpuSeconds" : process.type === "GPU" ? "gpuCpuSeconds" : "otherCpuSeconds";
      session[field] += process.cpuSeconds ?? 0;
    }
    sessions.set(key, session);
    for (const bucket of sample.git.buckets) {
      const key = `${bucket.source}:${bucket.command}`;
      const command = commands.get(key) ?? {
        source: bucket.source, command: bucket.command, started: 0, completed: 0, nonzero: 0, wallSeconds: 0
      };
      command.started += bucket.started;
      command.completed += bucket.completed;
      command.nonzero += bucket.nonzero;
      command.wallSeconds += bucket.wallMs / 1000;
      session.gitStarts += bucket.started;
      commands.set(key, command);
    }
  }
  return {
    sessions: [...sessions.values()],
    commands: [...commands.values()].sort((a, b) => b.started - a.started)
  };
}

async function runCli() {
  const directory = process.argv[2];
  const hours = Number(process.argv[3] ?? 12);
  if (!directory || !Number.isFinite(hours) || hours <= 0) {
    throw new Error("Usage: node apps/desktop/scripts/resource-usage-report.mjs <resources-directory> [hours=12]");
  }
  const cutoff = Date.now() - hours * 3_600_000;
  const samples = [];
  for (const file of (await readdir(directory)).sort()) {
    if (!/^resource-usage-\d{4}-\d{2}-\d{2}T\d{2}\.ndjson$/.test(file)) continue;
    for (const line of (await readFile(join(directory, file), "utf8")).split("\n")) {
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        if (Date.parse(sample.at) >= cutoff) samples.push(sample);
      } catch { /* A process may have exited during its last append. */ }
    }
  }
  const report = summarizeResources(samples);
  console.log(`Last ${hours} hours: ${samples.length} samples. CPU seconds exclude Git children and exited-between-sample helpers.`);
  console.table(report.sessions);
  console.log("Git wall seconds are summed subprocess lifetimes, not CPU time. Nonzero includes normal negative probes.");
  console.table(report.commands);
}

if (isCliEntrypoint(import.meta.url)) {
  runCli().catch((cause) => { console.error(cause.message); process.exitCode = 1; });
}
