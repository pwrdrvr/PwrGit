import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { err, ok, TAG_SOURCE_SYNC_TTL_MS } from "@pwrgit/shared";
import { expect, it, vi } from "vitest";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import * as dugite from "./dugite";
import type { GitExec } from "./dugite";
import { TagAutoChecks } from "./tag-auto-check";
import { TagSources } from "./tag-sources";
import { createSystemGit } from "./test-support/system-git";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

const NOW = TAG_SOURCE_SYNC_TTL_MS * 3;
const ORIGINAL = "a".repeat(40);
const MOVED = "b".repeat(40);
const URL = "/fixtures/origin.git";
const fileGit = createSystemGit({
  env: { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
});

async function fixtureGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await fileGit(args, cwd);
  if (!result.ok || result.value.exitCode !== 0) throw new Error(JSON.stringify(result));
  return result.value.stdout.trim();
}

function profiles(db: DB): void {
  db.exec(`
    INSERT INTO profiles (id, name, email) VALUES ('p', 'Mine', 'mine@example.test'),
      ('other', 'Other', 'other@example.test');
    INSERT INTO repos (id, profile_id, name, path) VALUES ('other', 'other', 'r0', '/outside/r0');
  `);
}

it("resolves configuration once per after-sync check in a burst", async () => {
  const db = openDatabase(":memory:");
  const sources = new TagSources(db, () => NOW);
  try {
    profiles(db);
    const insert = db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, 'p', ?, ?)");
    const dimensions = fc.record({
      repos: fc.integer({ min: 1, max: 8 }),
      tags: fc.integer({ min: 1, max: 16 }),
      cycle: fc.constantFrom("warm", "expired", "uncached"),
      moved: fc.boolean()
    });
    await fc.assert(fc.asyncProperty(dimensions, async ({ repos, tags, cycle, moved }) => {
      db.exec("DELETE FROM repos WHERE profile_id = 'p'");
      const listed = Array.from({ length: tags }, (_, i) => ({
        name: `release-${i}`, objectId: ORIGINAL, targetId: ORIGINAL, annotated: false
      }));
      const remote = listed.map(({ name }) => `${ORIGINAL}\trefs/tags/${name}`).join("\n");
      const local = listed.map(({ name }, i) => `${moved && i === 0 ? MOVED : ORIGINAL} refs/tags/${name}`).join("\n");
      const calls = { config: 0, refs: 0, listings: 0 };
      const git: GitExec = async (args, cwd) => {
        expect(cwd).toMatch(/^\/mine\/r\d+$/);
        let stdout: string;
        switch (args[0]) {
          case "config": calls.config++; stdout = `remote.origin.url\n${URL}\0`; break;
          case "for-each-ref": calls.refs++; stdout = local; break;
          case "ls-remote": calls.listings++; stdout = remote; break;
          default: throw new Error(`Unexpected Git command: ${args.join(" ")}`);
        }
        return ok({ stdout, stderr: "", exitCode: 0 });
      };
      const checks = new TagAutoChecks(db, { git, sources, now: () => NOW });
      for (let i = 0; i < repos; i++) {
        const id = `r${i}`;
        insert.run(id, id, `/mine/${id}`);
        if (cycle !== "uncached") {
          sources.store.recordListing(id, "origin", URL, listed, cycle === "warm" ? NOW - 1 : NOW - TAG_SOURCE_SYNC_TTL_MS - 1);
        }
        checks.afterSync(id);
      }
      await setImmediate();
      for (let i = 0; i < repos; i++) {
        expect(sources.store.snapshot(`r${i}`, "origin")).toMatchObject({ tag_count: tags, differs: Number(moved) });
      }
      expect(sources.store.snapshot("other", "origin")).toBeNull();
      expect(calls).toEqual({ config: repos, refs: repos, listings: cycle === "warm" ? 0 : repos });
    }), { seed: 2026112719, numRuns: 60 });
  } finally {
    db.close();
  }
});

it("sees a tag moved outside PwrGit with one config read and one local ref scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-after-sync-"));
  const db = openDatabase(":memory:");
  const setup = (...args: string[]) => fixtureGit(root, ...args);
  try {
    profiles(db);
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('r0', 'p', 'Fixture', ?)").run(root);
    await setup("init", "-q", "-b", "main");
    await setup("remote", "add", "origin", URL);
    const commit = (message: string) => setup(
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--allow-empty", "-qm", message
    );
    await commit("one");
    const original = await setup("rev-parse", "HEAD");
    await setup("tag", "release");
    await setup("init", "--bare", "-q", "publisher.git");
    await setup("push", "./publisher.git", "refs/tags/release");
    await commit("two");
    const moved = await setup("rev-parse", "HEAD");
    await setup("tag", "-f", "release");
    expect(await setup("rev-parse", "refs/tags/release")).toBe(moved);
    const sources = new TagSources(db, () => NOW);
    sources.store.recordListing("r0", "origin", URL, [
      { name: "release", objectId: original, targetId: original, annotated: false }
    ], NOW - 1);
    const calls: string[] = [];
    const counted: GitExec = (args, cwd, options) => {
      calls.push(args[0]!);
      return fileGit(args, cwd, options);
    };
    vi.mocked(emitEvent).mockClear();
    const checks = new TagAutoChecks(db, { git: counted, sources, now: () => NOW });
    checks.afterSync("r0");
    await vi.waitFor(() => expect(sources.store.snapshot("r0", "origin")?.differs).toBe(1), { interval: 10 });
    expect(sources.store.moves("r0", ["origin"], [{ name: "release", objectId: moved }]).get("release")?.objectId)
      .toBe(original);
    expect(vi.mocked(emitEvent).mock.calls).toEqual([
      ["tag:changed", { profileId: "p", repoId: "r0", refreshPreview: true }],
      ["graph:changed", { repoId: "r0" }]
    ]);
    expect(calls).toEqual(["config", "for-each-ref"]);

    // Changing the configured URL expires a snapshot even within its TTL.
    await setup("remote", "set-url", "origin", "./publisher.git");
    calls.length = 0;
    vi.mocked(emitEvent).mockClear();
    checks.afterSync("r0");
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalled(), { interval: 10 });
    expect(calls).toEqual(["config", "ls-remote", "for-each-ref"]);
    expect(sources.store.snapshot("r0", "origin")).toMatchObject({
      fetch_url: "./publisher.git", checked_at_ms: NOW, differs: 1
    });
    expect(vi.mocked(emitEvent).mock.calls).toEqual([
      ["tag:changed", { profileId: "p", repoId: "r0", refreshPreview: true }]
    ]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["bundled", "user-selected"])("stores the listed publisher's tags when origin is repointed (%s Git)", async (runtime) => {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-after-sync-repointed-"));
  const db = openDatabase(":memory:");
  const setup = (...args: string[]) => fixtureGit(root, ...args);
  const pin = runtime === "bundled";
  const selection = vi.spyOn(dugite, "installedGitSelection").mockReturnValue(pin ? null : "/fixture/git");
  try {
    profiles(db);
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('r0', 'p', 'Fixture', ?)").run(root);
    await setup("init", "-q", "-b", "main");
    await setup("init", "--bare", "-q", "a.git");
    await setup("init", "--bare", "-q", "b.git");
    await setup("remote", "add", "origin", "./a.git");
    const publish = async (repo: string): Promise<string> => {
      await setup("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "commit", "--allow-empty", "-qm", repo);
      const oid = await setup("rev-parse", "HEAD");
      await setup("tag", "-f", "release", oid);
      await setup("push", repo, "refs/tags/release");
      return oid;
    };
    const a = await publish("./a.git");
    const b = await publish("./b.git");
    expect(a).not.toBe(b);
    const sources = new TagSources(db, () => NOW);
    const calls: string[] = [];
    const repointingGit: GitExec = async (args, cwd, options) => {
      calls.push(args[0]!);
      const result = await fileGit(args, cwd, options);
      if (args[0] === "config") await setup("remote", "set-url", "origin", "./b.git");
      return result;
    };
    const checks = new TagAutoChecks(db, { git: repointingGit, sources, now: () => NOW });
    vi.mocked(emitEvent).mockClear();
    checks.afterSync("r0");
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalled(), { interval: 10 });
    expect(sources.store.snapshot("r0", "origin")).toMatchObject({
      fetch_url: pin ? "./a.git" : "./b.git", checked_at_ms: NOW
    });
    expect(sources.store.tags("r0", "origin")?.get("release")?.objectId).toBe(pin ? a : b);
    expect(await setup("remote", "get-url", "origin")).toBe("./b.git");
    expect(await sources.source(fileGit, "r0", root)).toMatchObject({ value: { state: { stale: pin } } });
    await setup("remote", "set-url", "origin", "./a.git");
    expect(await sources.source(fileGit, "r0", root)).toMatchObject({ value: { state: { stale: !pin } } });
    expect(calls).toEqual(pin ? ["config", "ls-remote", "for-each-ref"] : ["config", "config", "ls-remote", "for-each-ref"]);
  } finally {
    selection.mockRestore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("re-resolves the publisher after awaiting a failed listing and backs off only that remote", async () => {
  const db = openDatabase(":memory:");
  try {
    profiles(db);
    db.exec("INSERT INTO repos (id, profile_id, name, path) VALUES ('r0', 'p', 'Fixture', '/mine')");
    const sources = new TagSources(db, () => NOW);
    sources.store.recordListing("r0", "mirror", "/mirror.git", [
      { name: "release", objectId: ORIGINAL, targetId: ORIGINAL, annotated: false }
    ], NOW - 1);
    let config = `remote.origin.url\n${URL}\0`;
    const listings: string[] = [];
    const git: GitExec = async (args) => {
      if (args[0] === "config") return ok({ stdout: config, stderr: "", exitCode: 0 });
      if (args[0] === "for-each-ref") return ok({ stdout: `${MOVED} refs/tags/release\n`, stderr: "", exitCode: 0 });
      expect(args[0]).toBe("ls-remote");
      listings.push(args[2]!);
      if (args[2] === "origin") {
        await setImmediate();
        config += "remote.mirror.url\n/mirror.git\0";
        sources.setPrimary("r0", "mirror");
        return err({ kind: "git", code: "spawn_failed", message: "offline" });
      }
      return ok({ stdout: `${ORIGINAL}\trefs/tags/release\n`, stderr: "", exitCode: 0 });
    };
    const checks = new TagAutoChecks(db, { git, sources, now: () => NOW });
    checks.afterSync("r0");
    await vi.waitFor(() => expect(sources.store.snapshot("r0", "mirror")?.differs).toBe(1), { interval: 10 });
    expect(sources.store.snapshot("r0", "origin")?.error).toBe("offline");
    expect(listings).toEqual(["origin"]);

    sources.setPrimary("r0", "origin");
    checks.afterSync("r0");
    await setImmediate();
    expect(listings).toEqual(["origin"]);

    sources.setPrimary("r0", "mirror");
    config = config.replace("/mirror.git", "/new-mirror.git");
    checks.afterSync("r0");
    await setImmediate();
    expect(listings).toEqual(["origin", "mirror"]);
    expect(sources.store.snapshot("r0", "mirror")?.fetch_url).toBe("/new-mirror.git");
  } finally {
    db.close();
  }
});
