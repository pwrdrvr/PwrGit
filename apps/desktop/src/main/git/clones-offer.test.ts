import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import { readClonesOfferRecord, registerClonesOfferHandlers } from "./clones-offer";
import { clonesDryRunFromPorcelain, parseReflinkPorcelain } from "./worktree-reshare";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./runtime-status", () => ({ refreshActiveGitReflink: vi.fn(async () => undefined) }));

const GIB = 1024 * 1024 * 1024;
const record = (...fields: string[]): string => fields.map((field) => `${field}\0`).join("") + "\0";
/** A dry run's porcelain, as PwrGit's Git 2.56.0-dev-pwrgit.4 prints it. */
const dryRun = (summary: Record<string, string | number>, backend = "clone-replace"): string =>
  record("reflink 1", "worktree /w", "dry-run 1", `backend ${backend}`) +
  record("path a.bin", "status eligible", "reason dry-run-estimate") +
  record("summary", ...Object.entries(summary).map(([key, value]) => `${key} ${value}`));

let db: DB;
let bus: CommandBus;
let git: ReturnType<typeof vi.fn<GitExec>>;
/** Bytes each worktree path's dry run projects. */
let projected: Map<string, number>;
let canReshare: boolean;

function addRepo(id: string, profile: string, worktrees: Array<{ id: string; primary?: boolean; missing?: boolean; locked?: boolean }>): void {
  db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)").run(id, profile, id, `/r/${id}`);
  for (const wt of worktrees)
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary, missing, locked) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(wt.id, id, wt.id, `/w/${wt.id}`, wt.primary ? 1 : 0, wt.missing ? 1 : 0, wt.locked ? 1 : 0);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  for (const id of ["one", "two"])
    db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(id, id, `${id}@example.test`);
  // Two profiles whose worktrees would each, alone, be worth an offer.
  addRepo("a", "one", [{ id: "a-main", primary: true }, { id: "a-1" }, { id: "a-gone", missing: true }, { id: "a-locked", locked: true }]);
  addRepo("b", "two", [{ id: "b-main", primary: true }, { id: "b-1" }]);
  projected = new Map([["/w/a-1", 3 * GIB], ["/w/b-1", 5 * GIB], ["/w/a-gone", 9 * GIB], ["/w/a-locked", 9 * GIB], ["/w/a-main", 9 * GIB]]);
  canReshare = true;
  git = vi.fn<GitExec>(async (args, cwd) =>
    ok({
      stdout: dryRun({ eligible: 40, "potential-private-reduction": projected.get(cwd) ?? 0, "allocation-unknown": 0 }),
      stderr: "",
      exitCode: args.includes("-n") ? 0 : 1
    })
  );
  bus = new CommandBus();
  registerClonesOfferHandlers(bus, db, git, new WorktreeOperationQueue(), () => 1_000, async () => canReshare);
});
afterEach(() => db.close());

const offer = (profileId: string) => bus.dispatch("maintenance:clonesOffer", { profileId });

describe("maintenance:clonesOffer", () => {
  it("dry-runs only this profile's linked, present, unlocked worktrees, and offers Git's figure", async () => {
    expect(await offer("one")).toEqual({ ok: true, value: { kind: "bytes", bytes: 3 * GIB, atLeast: false } });
    const asked = git.mock.calls.map(([args, cwd]) => `${cwd} ${args.join(" ")}`);
    expect(asked).toEqual(["/w/a-1 worktree reflink -n --porcelain -z"]);
    expect(readClonesOfferRecord(db, "one")).toBe("offered");
    // The other profile is untouched, and decides on its own worktrees.
    expect(readClonesOfferRecord(db, "two")).toBeNull();
    expect(await offer("two")).toEqual({ ok: true, value: { kind: "bytes", bytes: 5 * GIB, atLeast: false } });
  });

  it("answers once: every later ask is null and runs no Git", async () => {
    await offer("one");
    git.mockClear();
    expect(await offer("one")).toEqual({ ok: true, value: null });
    expect(git).not.toHaveBeenCalled();
  });

  it("two asks at once scan once and raise one offer", async () => {
    const [first, second] = await Promise.all([offer("one"), offer("one")]);
    const values = [first, second].map((answer) => (answer.ok ? answer.value : "error"));
    expect(values.filter((value) => value !== null)).toHaveLength(1);
    expect(git).toHaveBeenCalledTimes(1);
  });

  it("records no_offer below the threshold, and never scans again", async () => {
    projected.set("/w/a-1", 10 * 1024 * 1024);
    expect(await offer("one")).toEqual({ ok: true, value: null });
    expect(readClonesOfferRecord(db, "one")).toBe("no_offer");
    projected.set("/w/a-1", 30 * GIB);
    git.mockClear();
    expect(await offer("one")).toEqual({ ok: true, value: null });
    expect(git).not.toHaveBeenCalled();
  });

  it("records nothing on a Git that cannot re-share, so a later PwrGit's Git still gets the scan", async () => {
    canReshare = false;
    expect(await offer("one")).toEqual({ ok: true, value: null });
    expect(git).not.toHaveBeenCalled();
    expect(readClonesOfferRecord(db, "one")).toBeNull();
    canReshare = true;
    expect((await offer("one")).ok && (await offer("two")).ok).toBe(true);
    expect(readClonesOfferRecord(db, "one")).toBe("offered");
  });

  it("records nothing when every dry run failed", async () => {
    git.mockImplementation(async () => ok({ stdout: "", stderr: "fatal: boom", exitCode: 128 }));
    expect(await offer("one")).toEqual({ ok: true, value: null });
    expect(readClonesOfferRecord(db, "one")).toBeNull();
  });

  it("keeps the answer, which never reopens the offer", async () => {
    await offer("one");
    await bus.dispatch("maintenance:clonesOfferAnswer", { profileId: "one", answer: "dismissed" });
    expect(readClonesOfferRecord(db, "one")).toBe("dismissed");
    // A late second answer does not overwrite the first.
    await bus.dispatch("maintenance:clonesOfferAnswer", { profileId: "one", answer: "accepted" });
    expect(readClonesOfferRecord(db, "one")).toBe("dismissed");
    expect(await offer("one")).toEqual({ ok: true, value: null });
  });

  it("deleting a profile drops its record", async () => {
    await offer("one");
    db.prepare("DELETE FROM profiles WHERE id = ?").run("one");
    expect(db.prepare("SELECT COUNT(*) AS n FROM profile_notices").get()).toEqual({ n: 0 });
  });
});

describe("clonesDryRunFromPorcelain", () => {
  const parse = (stdout: string, exitCode = 0) => clonesDryRunFromPorcelain(parseReflinkPorcelain(stdout), exitCode);
  it("reads Git's projection and eligible count", () => {
    expect(parse(dryRun({ eligible: 20, "potential-private-reduction": 19_070_976, "allocation-unknown": 0 })))
      .toEqual({ kind: "measured", bytes: 19_070_976, eligible: 20, partial: false });
  });
  it("marks a figure with unknown allocations as a floor", () => {
    expect(parse(dryRun({ eligible: 20, "potential-private-reduction": 4096, "allocation-unknown": 3 })))
      .toEqual({ kind: "measured", bytes: 4096, eligible: 20, partial: true });
  });
  it("reports no figure, not zero, when Git could not measure", () => {
    expect(parse(dryRun({ eligible: 700, "potential-private-reduction": "unknown" })))
      .toEqual({ kind: "unmeasured", eligible: 700 });
  });
  it("counts a volume that cannot clone as nothing to gain", () => {
    expect(parse(dryRun({ eligible: 700 }, "unsupported"))).toEqual({ kind: "measured", bytes: 0, eligible: 0, partial: false });
  });
  it("fails on a non-zero exit or a missing summary", () => {
    expect(parse(dryRun({ eligible: 1, "potential-private-reduction": 1 }), 128)).toEqual({ kind: "failed" });
    expect(parse(record("reflink 1"))).toEqual({ kind: "failed" });
  });
});
