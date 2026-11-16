import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { summarizeResources } from "./resource-usage-report.mjs";

describe("resource report conservation", () => {
  it("agrees with totals regardless of sample partition or input order", () => {
    fc.assert(fc.property(fc.array(fc.record({
      pid: fc.integer({ min: 1, max: 3 }), cpu: fc.nat(1000), started: fc.nat(1000), wall: fc.nat(1000)
    }), { minLength: 1, maxLength: 100 }), (rows) => {
      const samples = rows.map((r) => ({
        version: 1, mainPid: r.pid, intervalMs: 60_000,
        processes: [{ type: "Browser", cpuSeconds: r.cpu }],
        git: { peak: 1, buckets: [{ source: "bulk-pull", command: "status", started: r.started, completed: r.started, nonzero: 0, wallMs: r.wall }] }
      }));
      const report = summarizeResources(samples);
      expect(report.sessions.reduce((n, s) => n + s.mainCpuSeconds, 0)).toBe(rows.reduce((n, r) => n + r.cpu, 0));
      expect(report.sessions.reduce((n, s) => n + s.gitStarts, 0)).toBe(rows.reduce((n, r) => n + r.started, 0));
      expect(report.commands[0].started).toBe(rows.reduce((n, r) => n + r.started, 0));
      expect(report.commands[0].wallSeconds).toBeCloseTo(rows.reduce((n, r) => n + r.wall, 0) / 1000);
      expect(summarizeResources([...samples].reverse()).commands[0].started).toBe(report.commands[0].started);
    }));
  });
});
