import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { err, ok, type BulkSyncWorktreeResult, type MaintenanceRepo } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import {
  parseReflinkPorcelain,
  refreshRepositoryClones,
  reshareResultFromPorcelain,
  type ReshareWorktreeRow
} from "./worktree-reshare";

/** Git's `--porcelain -z` writer: NUL after every field, an empty field
 *  after every record. */
const serialize = (records: Array<Array<[string, string | null]>>): string =>
  records
    .map((fields) => `${fields.map(([key, value]) => (value === null ? key : `${key} ${value}`)).join("\0")}\0\0`)
    .join("");

const RESERVED = new Set(["reflink", "path", "summary"]);
const fieldKey = fc.stringMatching(/^[a-z][a-z-]{0,11}$/).filter((key) => !RESERVED.has(key));
// Paths may hold spaces and newlines; only NUL can't appear in a field.
const fieldValue = fc.string({ unit: "binary", maxLength: 16 }).filter((value) => !value.includes("\0"));
const extraFields = fc.uniqueArray(fc.tuple(fieldKey, fieldValue), { selector: ([key]) => key, maxLength: 4 });

describe("git worktree reflink porcelain, for any record set", () => {
  it("parses back exactly the header, path records and summary Git wrote", () => {
    fc.assert(
      fc.property(
        extraFields,
        fc.array(fc.tuple(fieldValue.filter((path) => path !== ""), extraFields), { maxLength: 6 }),
        fc.option(extraFields, { nil: null }),
        (header, paths, summary) => {
          const records: Array<Array<[string, string | null]>> = [
            [["reflink", "1"], ...header],
            ...paths.map(([path, fields]): Array<[string, string | null]> => [["path", path], ...fields]),
            ...(summary === null ? [] : [[["summary", null] as [string, null], ...summary]])
          ];
          const parsed = parseReflinkPorcelain(serialize(records));
          expect([...parsed.header]).toEqual([["reflink", "1"], ...header]);
          expect(parsed.paths.map((record) => [...record])).toEqual(
            paths.map(([path, fields]) => [["path", path], ...fields])
          );
          expect(parsed.summary === null ? null : [...parsed.summary]).toEqual(
            summary === null ? null : [["summary", ""], ...summary]
          );
        }
      )
    );
  });
});

const STATUSES = ["reshared", "already-shared", "skipped", "failed", "eligible"] as const;
// The quiet ones are never candidates (symlinks, submodules, sparse entries,
// a file already shared); `null` is a record with no reason field at all.
const QUIET = ["index-entry", "fully-shared", null] as const;
const LOUD = ["target-dirty", "no-donor", "hardlinked-target", "representation-differs", "some-future-reason"] as const;

describe("a worktree's re-share result, for any answer Git gives", () => {
  it("counts what Git counted, leaves never-candidates out of the skips, and names only loud reasons", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom(...STATUSES),
            reason: fc.constantFrom<string | null>(...QUIET, ...LOUD)
          }),
          { maxLength: 12 }
        ),
        fc.constantFrom(0, 1),
        (files, exitCode) => {
          const tally = (status: string): number => files.filter((file) => file.status === status).length;
          const records: Array<Array<[string, string | null]>> = [
            [["reflink", "1"], ["backend", "clone-replace"]],
            ...files.map(({ status, reason }, index): Array<[string, string | null]> => [
              ["path", `f${index}`],
              ["status", status],
              ...(reason === null ? [] : [["reason", reason] as [string, string]])
            ]),
            [
              ["summary", null],
              ["reshared", String(tally("reshared"))],
              ["already-shared", String(tally("already-shared"))],
              ["skipped", String(tally("skipped"))],
              ["failed", String(tally("failed"))]
            ]
          ];
          const result = reshareResultFromPorcelain(
            { id: "w", path: "/w", branch: "b" },
            parseReflinkPorcelain(serialize(records)),
            exitCode,
            exitCode === 0 ? "" : "fatal: something"
          );
          const loudSkips = files.filter(
            (file) => file.status === "skipped" && !(QUIET as readonly (string | null)[]).includes(file.reason)
          );
          expect(result.reshared).toBe(tally("reshared"));
          expect(result.alreadyShared).toBe(tally("already-shared"));
          expect(result.failed).toBe(tally("failed"));
          expect(result.skipped).toBe(loudSkips.length);
          // A never-candidate is not a reason a reader can act on.
          expect(result.message).not.toMatch(/index entry|fully shared/);
          if (loudSkips.length === 0) expect(result.message).not.toContain("left as they are");
          // Failure wins; otherwise the best thing that happened names it.
          const expected =
            tally("failed") > 0 || exitCode !== 0
              ? "failed"
              : tally("reshared") > 0
                ? "reshared"
                : tally("already-shared") > 0
                  ? "already_shared"
                  : "skipped";
          expect(result.outcome).toBe(expected);
        }
      )
    );
  });
});

/**
 * The orchestration, against a model of the queue and of Git. Rules, from
 * the function's contract:
 * - every linked worktree gets one row, in the worktrees' order;
 * - a missing or locked worktree is reported, never run;
 * - Git only touches a worktree while holding that worktree's lock, and the
 *   donor `status` holds the main checkout's;
 * - at most `concurrency` re-shares run at once;
 * - nothing starts once cancelled, and what didn't start says so;
 * - "Worktree N of M" counts exactly the re-shares that started;
 * - the repository's outcome follows its rows.
 */
describe("refreshRepositoryClones, for any worktrees, answers, timing and cancel point", () => {
  type Plan = { missing: boolean; locked: boolean; answer: "reshared" | "skipped" | "exit" | "spawn" };
  const repo: MaintenanceRepo = { id: "r", name: "fixture", path: "/m", profileId: "p", profileName: "P" };
  const porcelain = (status: string): string =>
    serialize([
      [["reflink", "1"], ["backend", "clone-replace"]],
      [["path", "a.bin"], ["status", status], ["reason", status === "skipped" ? "no-donor" : "fully-shared"]],
      [["summary", null], ["reshared", status === "reshared" ? "1" : "0"], ["skipped", status === "skipped" ? "1" : "0"], ["failed", "0"]]
    ]);

  it("keeps every rule above", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(
          fc.record({
            missing: fc.boolean(),
            locked: fc.boolean(),
            answer: fc.constantFrom<Plan["answer"]>("reshared", "skipped", "exit", "spawn")
          }),
          { maxLength: 6 }
        ),
        fc.record({
          updateMain: fc.boolean(),
          pull: fc.constantFrom<BulkSyncWorktreeResult["outcome"]>("updated", "up_to_date", "skipped", "failed"),
          concurrency: fc.integer({ min: 1, max: 4 }),
          // Cancel just before the Nth Git call answers; null never cancels.
          cancelAt: fc.option(fc.nat({ max: 12 }), { nil: null })
        }),
        async (s, plans, { updateMain, pull, concurrency, cancelAt }) => {
          const controller = new AbortController();
          const primary: ReshareWorktreeRow = {
            id: "main", path: "/m", branch: "main", isPrimary: true, missing: false, locked: false
          };
          const linked = plans.map((plan, index): ReshareWorktreeRow => ({
            id: `w${index}`, path: `/w${index}`, branch: `b${index}`, isPrimary: false, missing: plan.missing, locked: plan.locked
          }));
          const byPath = new Map([primary, ...linked].map((row) => [row.path, row]));
          const held = new Set<string>();
          const tails = new Map<string, Promise<void>>();
          const violations: string[] = [];
          const reshareStarts: string[] = [];
          let inFlight = 0;
          let peak = 0;
          let calls = 0;
          let startsAfterCancel = 0;

          const git: GitExec = async (args, cwd) => {
            const row = byPath.get(cwd);
            const reshare = args[0] === "worktree" && args[1] === "reflink";
            if ((reshare || args[0] === "status") && (row === undefined || !held.has(row.id))) {
              violations.push(`${args.join(" ")} in ${cwd} without its lock`);
            }
            if (reshare) {
              if (controller.signal.aborted) startsAfterCancel += 1;
              reshareStarts.push(cwd);
              inFlight += 1;
              peak = Math.max(peak, inFlight);
            }
            try {
              await s.schedule(Promise.resolve(), `git ${args[0]} ${cwd}`);
              calls += 1;
              if (cancelAt !== null && calls >= cancelAt) controller.abort();
              if (args[0] === "symbolic-ref") return ok({ stdout: "main\n", stderr: "", exitCode: 0 });
              if (!reshare) return ok({ stdout: "", stderr: "", exitCode: 0 });
              const plan = plans[Number(cwd.slice(2))]!;
              if (plan.answer === "spawn") return err({ kind: "git", code: "spawn", message: "spawn failed" });
              if (plan.answer === "exit") return ok({ stdout: "", stderr: "fatal: no", exitCode: 128 });
              return ok({ stdout: porcelain(plan.answer), stderr: "", exitCode: 0 });
            } finally {
              if (reshare) inFlight -= 1;
            }
          };
          // The queue: one holder per worktree, waiting in order.
          const runWorktree = <T,>(id: string, operation: () => Promise<T>): Promise<T> => {
            const before = tails.get(id) ?? Promise.resolve();
            let release!: () => void;
            tails.set(id, before.then(() => new Promise<void>((resolve) => { release = resolve; })));
            return before.then(async () => {
              if (held.has(id)) violations.push(`${id} held twice`);
              held.add(id);
              try {
                return await operation();
              } finally {
                held.delete(id);
                release();
              }
            });
          };
          const reports: string[] = [];
          const result = await s.waitFor(
            refreshRepositoryClones({
              git,
              repo,
              worktrees: [primary, ...linked],
              updateMain,
              signal: controller.signal,
              report: (detail) => reports.push(detail),
              defaultBranch: async () => "main",
              softPull: async (row) =>
                s.schedule(Promise.resolve({ worktreeId: row.id, branch: row.branch, path: row.path, outcome: pull }), "pull"),
              runWorktree,
              sleep: () => s.schedule(Promise.resolve(), "sleep"),
              concurrency
            })
          );

          expect(violations).toEqual([]);
          expect(startsAfterCancel).toBe(0);
          expect(peak).toBeLessThanOrEqual(concurrency);
          const rows = result.reshare?.worktrees ?? [];
          if (linked.length === 0) {
            expect(result.outcome).toBe("skipped");
            return;
          }
          expect(rows.map((row) => row.path)).toEqual(linked.map((row) => row.path));
          for (const [index, plan] of plans.entries()) {
            if (plan.missing || plan.locked) expect(reshareStarts).not.toContain(`/w${index}`);
          }
          // Each started re-share is announced once, numbered in start order.
          const numbered = reports.filter((line) => line.startsWith("Worktree "));
          expect(numbered.map((line) => line.split(" · ")[0])).toEqual(
            reshareStarts.map((_, index) => `Worktree ${index + 1} of ${linked.length}`)
          );
          const cancelled = rows.filter((row) => row.message.startsWith("Cancelled")).length;
          expect(reshareStarts.length + cancelled + plans.filter((plan) => plan.missing || plan.locked).length)
            .toBeGreaterThanOrEqual(linked.length);
          if (cancelAt === null) expect(cancelled).toBe(0);
          const failed = rows.filter((row) => row.outcome === "failed").length;
          if (cancelled === rows.length) expect(result.outcome).toBe("cancelled");
          if (failed === rows.length) expect(result.outcome).toBe("failed");
          if (result.outcome === "success") {
            expect(failed + cancelled).toBe(0);
            expect(result.reshare?.main.outcome).not.toBe("failed");
          }
          if (failed > 0 && failed < rows.length) expect(result.outcome).toBe("partial");
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Git is the oracle for Clones' promise: re-sharing never changes anyone's
 * work. For any committed files and any loose edits in the main checkout
 * and a linked worktree (edits, deletions, mode changes, untracked and
 * ignored files), a run leaves every file's bytes and `git status` exactly
 * as they were, and a second run finds nothing new. Needs a Git with
 * `git worktree reflink`, so it runs locally with
 *   PWRGIT_TEST_GIT=installed PATH=<runtime>/bin:$PATH
 * and skips elsewhere, CI included.
 */
const realGit = createSystemGit();
const usage = await realGit(["worktree", "-h"], tmpdir());
const canReshare = usage.ok && /git worktree reflink\b/.test(usage.value.stdout);

describe.skipIf(!canReshare)("Clones against real Git, for any loose work", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-reshare-prop-")));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const sh = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  /** Every file's bytes and mode under a checkout, `.git` aside. */
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      if (full.includes(`${sep}.git`) || !entry.isFile()) continue;
      out[full.slice(dir.length)] = `${statSync(full).mode.toString(8)} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
    }
    return out;
  };
  const status = (dir: string): string => sh(dir, "status", "--porcelain=v1", "--ignored", "-z");

  const edit = fc.constantFrom("keep", "modify", "delete", "chmod");
  const file = fc.record({ size: fc.constantFrom(0, 3, 70_000), fill: fc.integer({ min: 1, max: 250 }), main: edit, worktree: edit });

  it("leaves every byte and every status line as it found them", { timeout: 60_000 }, async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(file, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        fc.boolean(),
        async (files, untracked, ignored) => {
          const dir = join(root, String((run += 1)));
          const main = join(dir, "main");
          const linked = join(dir, "linked");
          mkdirSync(main, { recursive: true });
          sh(main, "init", "-q", "-b", "main");
          sh(main, "config", "user.email", "t@example.com");
          sh(main, "config", "user.name", "T");
          sh(main, "config", "core.fileMode", "true");
          writeFileSync(join(main, ".gitignore"), "*.local\n");
          files.forEach((spec, index) => writeFileSync(join(main, `f${index}.bin`), Buffer.alloc(spec.size, spec.fill)));
          // Narrowed, not weakened: a file written in the same second as the
          // index that records it is racy, and Git won't clone from it until
          // the index ages past it (Clones waits for that after its own
          // fast-forward). Real checkouts are older than their index; these
          // were written a moment ago, so date them back.
          const past = new Date(Date.now() - 60_000);
          for (const name of readdirSync(main)) if (name !== ".git") utimesSync(join(main, name), past, past);
          sh(main, "add", ".");
          sh(main, "commit", "-qm", "base");
          sh(main, "-c", "checkout.reflink=false", "worktree", "add", "-q", "-b", "side", linked);
          const apply = (checkout: string, which: "main" | "worktree"): void => {
            files.forEach((spec, index) => {
              const path = join(checkout, `f${index}.bin`);
              if (spec[which] === "modify") writeFileSync(path, Buffer.alloc(spec.size + 1, spec.fill ^ 0xff));
              if (spec[which] === "delete") rmSync(path);
              if (spec[which] === "chmod") chmodSync(path, 0o755);
            });
          };
          apply(main, "main");
          apply(linked, "worktree");
          if (untracked) writeFileSync(join(linked, "scratch.txt"), "untracked\n");
          if (ignored) writeFileSync(join(linked, "secret.local"), "SECRET=1\n");
          const before = { main: snapshot(main), linked: snapshot(linked), mainStatus: status(main), linkedStatus: status(linked) };
          const rows: ReshareWorktreeRow[] = [
            { id: "main", path: main, branch: "main", isPrimary: true, missing: false, locked: false },
            { id: "side", path: linked, branch: "side", isPrimary: false, missing: false, locked: false }
          ];
          const refresh = () =>
            refreshRepositoryClones({
              git: realGit,
              repo: { id: "r", name: "fixture", path: main, profileId: "p", profileName: "P" },
              worktrees: rows,
              updateMain: false,
              signal: new AbortController().signal,
              report: () => undefined,
              defaultBranch: async () => "main",
              softPull: async () => { throw new Error("not asked"); },
              runWorktree: (_id, operation) => operation()
            });
          const first = await refresh();
          expect(first.reshare?.worktrees[0]?.outcome).not.toBe("failed");
          expect(snapshot(main)).toEqual(before.main);
          expect(snapshot(linked)).toEqual(before.linked);
          expect(status(main)).toBe(before.mainStatus);
          expect(status(linked)).toBe(before.linkedStatus);
          const second = await refresh();
          expect(second.reshare?.worktrees[0]?.reshared).toBe(0);
        }
      ),
      { numRuns: 25 }
    );
  });
});
