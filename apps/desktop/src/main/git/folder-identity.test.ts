import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRootOverlaps, rootOverlapMessage } from "@pwrgit/shared";
import { IDENTITY_ENV_VARIABLES } from "./commit-identity";
import {
  applyFolderSync,
  clearRepoOverride,
  desiredIncludes,
  includeCondition,
  inspectFolderIdentity,
  isManagedInclude,
  managedIncludeFile,
  planFolderSync,
  planIsApplied,
  type FolderIdentityDeps,
  type FolderProfileRow,
  type FolderRepoRow
} from "./folder-identity";
import { createSystemGit } from "./test-support/system-git";

// Real Git, in a sandbox: its own HOME, no system config, none of the
// identity variables of whoever runs the suite.

const sandboxes: string[] = [];
afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-folder-identity-")));
  sandboxes.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of IDENTITY_ENV_VARIABLES) delete env[variable];
  for (const variable of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]) {
    delete env[variable];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1"
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const repo = (...segments: string[]): string => {
    const path = join(root, ...segments);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    return path;
  };
  const deps: FolderIdentityDeps = { git: createSystemGit({ env }), env };
  const globalFile = join(home, ".gitconfig");
  return { root, home, env, git, repo, deps, globalFile };
}

function profiles(root: string): FolderProfileRow[] {
  return [
    {
      id: "personal",
      name: "Personal",
      mono: "P",
      email: "rowan@vale.example",
      authorName: null,
      roots: [join(root, "Code")]
    },
    {
      id: "work",
      name: "Work",
      mono: "W",
      email: "rowan@northwind.example",
      authorName: "Rowan Vale",
      roots: [join(root, "Work")]
    }
  ];
}

describe("identity by folder, against real Git", () => {
  it("writes an include per root that each repository then resolves", async () => {
    const box = sandbox();
    writeFileSync(box.globalFile, "[user]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n");
    const site = box.repo("Code", "site");
    const api = box.repo("Work", "api");
    const rows = profiles(box.root);
    const repos: FolderRepoRow[] = [
      { id: "r-site", profileId: "personal", name: "site", path: site },
      { id: "r-api", profileId: "work", name: "api", path: api }
    ];

    const before = await inspectFolderIdentity(box.deps, { enabled: false, profiles: rows, repos });
    const workBefore = before.profiles.find((p) => p.profileId === "work")!;
    expect(workBefore.repos[0]).toMatchObject({ email: "rowan@vale.example", source: "global", matches: false });
    expect(before.profiles.find((p) => p.profileId === "personal")!.repos[0]).toMatchObject({ matches: true });

    const plan = await planFolderSync(box.deps, rows, true);
    expect(plan.remove).toEqual([]);
    expect(plan.add.map((entry) => entry.path)).toEqual([
      managedIncludeFile(box.globalFile, "personal"),
      managedIncludeFile(box.globalFile, "work")
    ]);
    expect((await applyFolderSync(box.deps, plan)).ok).toBe(true);
    expect(await planIsApplied(box.deps, plan)).toBe(true);

    expect(box.git(api, "config", "--get", "user.email")).toBe("rowan@northwind.example");
    expect(box.git(site, "config", "--get", "user.email")).toBe("rowan@vale.example");
    const after = await inspectFolderIdentity(box.deps, { enabled: true, profiles: rows, repos });
    expect(after.profiles.find((p) => p.profileId === "work")!.repos[0]).toMatchObject({
      email: "rowan@northwind.example",
      authorName: "Rowan Vale",
      source: "pwrgit",
      matches: true
    });
    // The user's own [user] is untouched; only includes were appended.
    expect(readFileSync(box.globalFile, "utf8")).toMatch(/^\[user\]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n/);
  });

  it("re-appends the includes when a later [user] section shadows them", async () => {
    const box = sandbox();
    const api = box.repo("Work", "api");
    const rows = profiles(box.root);
    // No [user] yet: the includes land first, and a later `git config
    // --global user.email` appends a [user] after them, which wins.
    expect((await applyFolderSync(box.deps, await planFolderSync(box.deps, rows, true))).ok).toBe(true);
    box.git(box.home, "config", "--global", "user.email", "rowan@vale.example");
    expect(box.git(api, "config", "--get", "user.email")).toBe("rowan@vale.example");

    const plan = await planFolderSync(box.deps, rows, true);
    expect(await planIsApplied(box.deps, plan)).toBe(false);
    expect((await applyFolderSync(box.deps, plan)).ok).toBe(true);
    expect(box.git(api, "config", "--get", "user.email")).toBe("rowan@northwind.example");
    expect(await planIsApplied(box.deps, await planFolderSync(box.deps, rows, true))).toBe(true);
  });

  it("finds a repository's own email, and clears only that", async () => {
    const box = sandbox();
    const api = box.repo("Work", "api");
    box.git(api, "config", "user.email", "rowan@vale.example");
    box.git(api, "config", "core.autocrlf", "false");
    const rows = profiles(box.root);
    const repos: FolderRepoRow[] = [{ id: "r-api", profileId: "work", name: "api", path: api }];
    await applyFolderSync(box.deps, await planFolderSync(box.deps, rows, true));

    const report = await inspectFolderIdentity(box.deps, { enabled: true, profiles: rows, repos });
    expect(report.profiles.find((p) => p.profileId === "work")!.repos[0]).toMatchObject({
      email: "rowan@vale.example",
      source: "local",
      matches: false
    });
    expect((await clearRepoOverride(box.deps.git, api, rows[1]!)).ok).toBe(true);
    expect(box.git(api, "config", "--get", "user.email")).toBe("rowan@northwind.example");
    // Unrelated local config stays.
    expect(box.git(api, "config", "--local", "--get", "core.autocrlf")).toBe("false");
  });

  it("turning it off removes PwrGit's includes and files, and nobody else's", async () => {
    const box = sandbox();
    const own = join(box.home, ".gitconfig-moreau");
    writeFileSync(own, "[user]\n\temail = rowan@moreau.example\n");
    writeFileSync(
      box.globalFile,
      `[user]\n\temail = rowan@vale.example\n[includeIf "gitdir:${join(box.root, "Moreau").replace(/\\/g, "/")}/"]\n\tpath = ${own.replace(/\\/g, "/")}\n`
    );
    const rows = profiles(box.root);
    await applyFolderSync(box.deps, await planFolderSync(box.deps, rows, true));
    expect(existsSync(managedIncludeFile(box.globalFile, "work"))).toBe(true);

    const off = await planFolderSync(box.deps, rows, false);
    expect(off.remove).toHaveLength(2);
    expect(off.deleteFiles.sort()).toEqual(
      [managedIncludeFile(box.globalFile, "personal"), managedIncludeFile(box.globalFile, "work")].sort()
    );
    expect((await applyFolderSync(box.deps, off)).ok).toBe(true);
    const text = readFileSync(box.globalFile, "utf8");
    expect(text).not.toContain(".gitconfig-pwrgit-");
    expect(text).toContain(".gitconfig-moreau");
    expect(existsSync(own)).toBe(true);
    expect(existsSync(managedIncludeFile(box.globalFile, "work"))).toBe(false);
  });

  it("drops an include file when its profile goes", async () => {
    const box = sandbox();
    const rows = profiles(box.root);
    await applyFolderSync(box.deps, await planFolderSync(box.deps, rows, true));
    const plan = await planFolderSync(box.deps, rows.slice(0, 1), true);
    expect(plan.deleteFiles).toEqual([managedIncludeFile(box.globalFile, "work")]);
    await applyFolderSync(box.deps, plan);
    expect(readFileSync(box.globalFile, "utf8")).not.toContain("pwrgit-work");
    expect(existsSync(managedIncludeFile(box.globalFile, "work"))).toBe(false);
  });
});

describe("identity by folder, pure rules", () => {
  it("writes recursive, case-folded conditions where the file system folds case", () => {
    expect(includeCondition("/Users/rowan/Work", "darwin")).toBe("gitdir/i:/Users/rowan/Work/");
    expect(includeCondition("/home/rowan/Work/", "linux")).toBe("gitdir:/home/rowan/Work/");
    expect(includeCondition("C:\\Users\\rowan\\Work", "win32")).toBe("gitdir/i:C:/Users/rowan/Work/");
    // Wildmatch syntax in a real folder name is literal.
    expect(includeCondition("/home/rowan/[old] code", "linux")).toBe("gitdir:/home/rowan/\\[old\\] code/");
  });

  it("orders deeper roots last, and skips profiles with nothing to write", () => {
    const { includes, skipped } = desiredIncludes(
      [
        { id: "deep", name: "Deep", mono: "D", email: "d@x.example", authorName: null, roots: ["/a/b/c"] },
        { id: "shallow", name: "Shallow", mono: "S", email: "s@x.example", authorName: null, roots: ["/a"] },
        { id: "none", name: "None", mono: "N", email: "", authorName: null, roots: ["/z"] },
        { id: "rootless", name: "Rootless", mono: "R", email: "r@x.example", authorName: null, roots: [] }
      ],
      "/home/rowan/.gitconfig",
      "linux"
    );
    expect(includes.map((entry) => entry.condition)).toEqual(["gitdir:/a/", "gitdir:/a/b/c/"]);
    expect(skipped).toEqual([
      { profileId: "none", name: "None", reason: "no_email" },
      { profileId: "rootless", name: "Rootless", reason: "no_roots" }
    ]);
  });

  it("owns only its own include files", () => {
    expect(isManagedInclude("/home/r/.gitconfig", "/home/r/.gitconfig-pwrgit-work", false)).toBe(true);
    expect(isManagedInclude("/home/r/.gitconfig", "/home/r/.gitconfig-moreau", false)).toBe(false);
    expect(isManagedInclude("/home/r/.gitconfig", "/elsewhere/.gitconfig-pwrgit-work", false)).toBe(false);
  });

  it("names every way two profiles' roots can collide", () => {
    const others = [{ id: "work", name: "Work", roots: ["/Users/rowan/Work"] }];
    expect(findRootOverlaps(["/Users/rowan/Work/oss"], others, false)[0]?.relation).toBe("inside");
    expect(findRootOverlaps(["/Users/rowan"], others, false)[0]?.relation).toBe("contains");
    expect(findRootOverlaps(["/users/rowan/work/"], others, true)[0]?.relation).toBe("same");
    expect(findRootOverlaps(["/users/rowan/work"], others, false)).toEqual([]);
    // A sibling that shares a prefix is not inside.
    expect(findRootOverlaps(["/Users/rowan/Workshop"], others, false)).toEqual([]);
    const [inside] = findRootOverlaps(["/Users/rowan/Work/oss"], others, false);
    expect(rootOverlapMessage(inside!)).toBe(
      "/Users/rowan/Work/oss is inside /Users/rowan/Work, a folder of “Work”. A repository can belong to one profile, and its Git identity to one email."
    );
  });
});
