import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitExec } from "./dugite";
import {
  createForkSourceProbe,
  mayHaveForkSource,
  REMOTE_LIST_TTL_MS
} from "./fork-source-probe";
import { createSystemGit } from "./test-support/system-git";

const systemGit: GitExec = createSystemGit();

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function commit(dir: string, file: string): void {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", file]);
}

const endpoint = (name: string, url: string) => ({
  name,
  fetchUrl: url,
  pushUrl: url
});

describe("mayHaveForkSource", () => {
  it("settles a single-remote repository without asking anything else", () => {
    expect(
      mayHaveForkSource([endpoint("upstream", "git@github.com:octo/a.git")], null)
    ).toBe(false);
  });

  it("accepts a remote named upstream", () => {
    expect(
      mayHaveForkSource(
        [
          endpoint("origin", "git@github.com:me/a.git"),
          endpoint("upstream", "git@github.com:octo/a.git")
        ],
        null
      )
    ).toBe(true);
  });

  it("accepts a remote whose URL is the forge parent, whatever its name", () => {
    const remotes = [
      endpoint("origin", "git@github.com:me/a.git"),
      endpoint("octo", "https://github.com/Octo/A.git")
    ];
    expect(
      mayHaveForkSource(remotes, { hostname: "github.com", nameWithOwner: "octo/a" })
    ).toBe(true);
    expect(mayHaveForkSource(remotes, null)).toBe(false);
  });
});

describe("createForkSourceProbe (system git)", () => {
  let root: string;
  let seed: string;
  let fork: string;
  let plain: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-forksrc-")));
    const source = join(root, "source.git");
    const forkBare = join(root, "fork.git");
    seed = join(root, "seed");
    execFileSync("git", ["init", "--bare", "-b", "main", source], { stdio: "ignore" });
    execFileSync("git", ["clone", source, seed], { stdio: "ignore" });
    for (const dir of [seed]) {
      git(dir, ["config", "user.email", "t@t.com"]);
      git(dir, ["config", "user.name", "Tester"]);
      git(dir, ["config", "core.autocrlf", "false"]);
    }
    git(seed, ["checkout", "-b", "main"]);
    commit(seed, "one.txt");
    git(seed, ["push", "origin", "main"]);
    execFileSync("git", ["clone", "--bare", source, forkBare], { stdio: "ignore" });

    // The user's checkout: origin is their fork, upstream the source.
    fork = join(root, "fork");
    execFileSync("git", ["clone", forkBare, fork], { stdio: "ignore" });
    git(fork, ["remote", "add", "upstream", source]);
    // The source moves on by two commits the fork does not have.
    commit(seed, "two.txt");
    commit(seed, "three.txt");
    git(seed, ["push", "origin", "main"]);
    git(fork, ["fetch", "upstream"]);

    plain = join(root, "plain");
    execFileSync("git", ["clone", source, plain], { stdio: "ignore" });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("counts the checked-out branch against the fork's source", async () => {
    const probe = createForkSourceProbe(systemGit, () => null);
    const source = await probe("r", fork, fork);
    expect(source).toMatchObject({
      remote: "upstream",
      label: "upstream/main",
      ahead: 0,
      behind: 2
    });
  });

  // Nearly every repository is not a fork. Its answer is the remote list,
  // and that list is read once per repository per TTL — not once per
  // worktree per probe, which runs for every visible row every round.
  it("answers a repository with no source from the cached remote list", async () => {
    let calls = 0;
    const counting: GitExec = (args, cwd, options) => {
      calls += 1;
      return systemGit(args, cwd, options);
    };
    let clock = 1_000;
    const probe = createForkSourceProbe(counting, () => null, () => clock);

    expect(await probe("p", plain, plain)).toBeNull();
    expect(calls).toBe(1);
    expect(await probe("p", plain, plain)).toBeNull();
    expect(calls).toBe(1);

    clock += REMOTE_LIST_TTL_MS;
    expect(await probe("p", plain, plain)).toBeNull();
    expect(calls).toBe(2);
  });
});
