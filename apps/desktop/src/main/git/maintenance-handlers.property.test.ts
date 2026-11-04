import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMPTY_MAINTENANCE_RUN_VIEW,
  foldMaintenanceProgress,
  ok,
  type MaintenanceCurrent,
  type MaintenanceProgress,
  type MaintenanceRepoResult,
  type Result
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import { largestFirst, registerMaintenanceHandlers, splitByLinkedWorktrees } from "./maintenance-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  // Four repositories at once, so their events interleave.
  availableParallelism: () => 8
}));
vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

/**
 * Model test for reattaching to a maintenance run. The real handler runs a
 * collection over profile one; every Git call finishes when fast-check's
 * scheduler decides. In between, windows ask what is running (as a
 * reloaded window does), cancel, and acknowledge a receipt. Oracle: the
 * progress events main actually sent. Rules, at every point:
 *
 * - profile one's window always finds the run, live or finished, never
 *   neither, and a live answer is exactly the fold of the events sent so
 *   far;
 * - profile two's window never sees it, though an all-profiles run reaches
 *   its repository;
 * - only the window that started the run owns it and can cancel it, and the
 *   receipt says cancelled exactly when a cancel was accepted;
 * - the receipt holds the results the live events showed, and stays unseen
 *   until that run's own acknowledgement.
 */

const OWNER = 1;
const SIBLING = 9;
const TWO = 2;
let root: string;
let db: DB;
/** A fresh operation id per run: a failed run is left pending, and must not
 *  bleed its events into the next one while fast-check shrinks. */
let runs = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-maintenance-model-"));
  db = openDatabase(":memory:");
  for (const [id, name] of [["one", "One"], ["two", "Two"]] as const)
    db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(id, name, `${id}@example.test`);
  for (const [id, profile] of [["a", "one"], ["b", "one"], ["c", "one"], ["d", "two"]] as const) {
    const path = join(root, id);
    mkdirSync(join(path, ".git"), { recursive: true });
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)").run(id, profile, id, path);
  }
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

type Step =
  | { kind: "ask"; window: number; profileId: "one" | "two" }
  | { kind: "cancel"; window: number }
  /** `own`: this run's acknowledgement, else a stale one. */
  | { kind: "seen"; own: boolean }
  | { kind: "settle" };
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("ask" as const), window: fc.constantFrom(OWNER, SIBLING), profileId: fc.constant("one" as const) }),
  fc.record({ kind: fc.constant("ask" as const), window: fc.constant(TWO), profileId: fc.constant("two" as const) }),
  fc.record({ kind: fc.constant("cancel" as const), window: fc.constantFrom(OWNER, SIBLING) }),
  fc.record({ kind: fc.constant("seen" as const), own: fc.boolean() }),
  fc.constant({ kind: "settle" as const })
);

const byRepo = (rows: MaintenanceRepoResult[]): Record<string, MaintenanceRepoResult> =>
  Object.fromEntries(rows.map((row) => [row.repo.id, row]));

it("a reloaded window always finds its own profile's run, exactly as the events drew it", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.boolean(),
      fc.array(step, { minLength: 1, maxLength: 24 }),
      async (s, allProfiles, steps) => {
        const operationId = `run-${++runs}`;
        const bus = new CommandBus();
        const git = vi.fn<GitExec>((args, cwd) =>
          s.schedule(
            Promise.resolve(
              ok({
                stdout: args[0] === "rev-parse" ? join(cwd, ".git") : args[0] === "count-objects" ? "size: 32\nsize-pack: 64\n" : "",
                stderr: "",
                exitCode: 0
              })
            ),
            `${args[0]} ${cwd.slice(-1)}`
          )
        );
        registerMaintenanceHandlers(bus, db, git, new WorktreeOperationQueue(), {
          refreshRepoWorktrees: async () => ok(undefined)
        } as never);
        const sent = (): MaintenanceProgress[] =>
          vi.mocked(emitEvent).mock.calls
            .filter(([channel]) => channel === "maintenance:progress")
            .map(([, payload]) => payload as MaintenanceProgress)
            .filter((event) => event.operationId === operationId);
        /** Main answers synchronously, when asked; Git continuations can
         *  send more events before the await returns. So the oracle is the
         *  events sent at the moment of asking (`heard`), not after. */
        const ask = async (window: number, profileId: string): Promise<{ current: MaintenanceCurrent; heard: MaintenanceProgress[] }> => {
          const asked = bus.dispatch("maintenance:current", { profileId }, { webContentsId: window });
          const heard = sent();
          const answer = (await asked) as Result<MaintenanceCurrent>;
          if (!answer.ok) throw new Error(answer.error.message);
          return { current: answer.value, heard };
        };
        /** A request from a window reaches main as a macrotask: Git
         *  continuations already queued run first. Not a sleep; the
         *  scheduler still decides every ordering. */
        const arrival = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
        /** What one window is told, against what main had sent then. */
        const check = async (window: number, profileId: "one" | "two"): Promise<void> => {
          await arrival();
          const { current, heard } = await ask(window, profileId);
          if (profileId === "two") {
            expect(current).toBeNull();
            return;
          }
          // Never neither: from Start until the answer, it is here.
          expect(current).not.toBeNull();
          if (current === null) return;
          expect(current.run.ownWindow).toBe(window === OWNER);
          if (current.state === "running") {
            expect(current.view).toEqual(heard.reduce(foldMaintenanceProgress, EMPTY_MAINTENANCE_RUN_VIEW));
            expect(current.view.seq).toBe(heard.length);
            // Stopping exactly when a cancel was accepted, so a reloaded
            // window draws it as stopping.
            expect(current.cancelling).toBe(accepted);
          } else {
            expect(heard.at(-1)).toMatchObject({ phase: "finished", summary: current.summary });
          }
        };
        /** Main clears the live run and sends `finished` in one step. */
        const live = (): boolean => sent().length > 0 && sent().at(-1)?.phase !== "finished";

        let settled = false;
        const pending = bus
          .dispatch("maintenance:run", { profileId: "one", allProfiles, operationId, action: { kind: "gc", mode: "standard" } }, { webContentsId: OWNER })
          .finally(() => (settled = true));
        let accepted = false;
        let seenEarly = false;

        for (const next of steps) {
          if (next.kind === "settle") {
            if (s.count() > 0) await s.waitOne();
            continue;
          }
          if (next.kind === "seen") {
            // Acknowledging a receipt that does not exist yet does nothing.
            if (next.own && !live()) seenEarly = true;
            await bus.dispatch("maintenance:seen", { profileId: "one", operationId: next.own ? operationId : "older" });
            continue;
          }
          if (next.kind === "cancel") {
            const running = live();
            const answer = await bus.dispatch("maintenance:cancel", { operationId }, { webContentsId: next.window });
            // Only the window that started a live run can stop it.
            expect(answer).toEqual(ok({ cancelled: running && next.window === OWNER }));
            if (answer.ok && answer.value.cancelled) accepted = true;
            continue;
          }
          await check(next.window, next.profileId);
        }
        // Drain one Git call at a time, asking after each, so the run's
        // last steps (where it lets go and records its receipt) are asked
        // about on every run, not only when the steps above reach them.
        // `maintenanceCommonDirectory` resolves the store with a real
        // `realpath`, outside the scheduler, so an empty schedule is only
        // "stuck" once that I/O has had time (as the queue model does).
        for (let idle = 0; !settled; ) {
          await arrival();
          await check(OWNER, "one");
          if (settled) break;
          if (s.count() > 0) {
            idle = 0;
            await s.waitOne();
            continue;
          }
          if (++idle > 20) throw new Error("The run is waiting on something outside the scheduler.");
          await new Promise((resolve) => setTimeout(resolve, 2));
        }

        const response = await s.waitFor(pending);
        expect(settled).toBe(true);
        if (!response.ok) throw new Error(response.error.message);
        const summary = response.value;
        const events = sent();
        expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
        expect(events.at(-1)).toEqual(expect.objectContaining({ phase: "finished", summary }));
        expect(summary.cancelled).toBe(accepted);
        // The receipt and the live card agree, repository by repository.
        const drawn = events.reduce(foldMaintenanceProgress, EMPTY_MAINTENANCE_RUN_VIEW);
        expect(byRepo(summary.results)).toEqual(byRepo(drawn.results));
        expect(summary.results.map((row) => row.repo.id)).toEqual(["a", "b", "c", ...(allProfiles ? ["d"] : [])]);
        const { current: after } = await ask(OWNER, "one");
        expect(after).toEqual({ state: "finished", run: expect.objectContaining({ operationId, ownWindow: true }), summary, seen: seenEarly });
        expect((await ask(TWO, "two")).current).toBeNull();
      }
    ),
    // Each run waits on real `realpath` I/O; keep the file well inside the
    // 20 s timeout on Windows CI.
    { numRuns: 50 }
  );
});

const repos = fc.uniqueArray(fc.record({ id: fc.stringMatching(/^[a-z]{1,4}$/) }), { selector: (repo) => repo.id, maxLength: 12 });
const weights = (list: Array<{ id: string }>) =>
  fc.array(fc.nat({ max: 5 }), { minLength: list.length, maxLength: list.length }).map(
    (counts) => new Map(list.map((repo, index) => [repo.id, counts[index]!]))
  );

describe("Maintenance's run order and Clones' split, for any repositories and counts", () => {
  it("starts the heaviest first and keeps the given order among equals", () => {
    fc.assert(
      fc.property(repos.chain((list) => fc.tuple(fc.constant(list), weights(list))), ([list, weight]) => {
        const order = largestFirst(list, weight);
        // The same repositories, each once.
        expect([...order].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...list].sort((a, b) => a.id.localeCompare(b.id)));
        for (let i = 1; i < order.length; i += 1) {
          const before = weight.get(order[i - 1]!.id)!;
          const after = weight.get(order[i]!.id)!;
          expect(before).toBeGreaterThanOrEqual(after);
          if (before === after) expect(list.indexOf(order[i - 1]!)).toBeLessThan(list.indexOf(order[i]!));
        }
      })
    );
  });

  it("runs exactly the repositories with a linked worktree and lists every other one apart", () => {
    fc.assert(
      fc.property(repos.chain((list) => fc.tuple(fc.constant(list), weights(list))), ([list, linked]) => {
        const { withWorktrees, noWorktrees } = splitByLinkedWorktrees(list, linked);
        expect(withWorktrees).toEqual(list.filter((repo) => linked.get(repo.id)! > 0));
        expect(noWorktrees).toEqual(list.filter((repo) => linked.get(repo.id) === 0));
      })
    );
  });
});
