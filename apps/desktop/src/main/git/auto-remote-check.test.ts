import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import { createSystemGit } from "./test-support/system-git";
import { timedGitSync } from "./test-support/git-tripwire";
import { checkSelectedRemoteTips, ensureForkParentRemote } from "./auto-remote-check";

const systemGit = createSystemGit();

function git(cwd: string, ...args: string[]): string {
  return timedGitSync(args, cwd, () =>
    execFileSync("git", ["-C", cwd, ...args], {
      cwd: tmpdir(), encoding: "utf8"
    }).trim()
  );
}

describe("automatic selected-branch remote check", () => {
  it("wires a stored fork parent once so the ordinary source status can see it", async () => {
    const remotes = new Map([["origin", "git@github.com:me/fork.git"]]);
    const commands: string[][] = [];
    const git: GitExec = async (args) => {
      commands.push(args);
      if (args[0] === "remote" && args[1] === "-v") {
        return ok({
          exitCode: 0,
          stdout: [...remotes].flatMap(([name, url]) => [
            `${name}\t${url} (fetch)`, `${name}\t${url} (push)`
          ]).join("\n") + "\n",
          stderr: ""
        });
      }
      if (args[0] === "remote" && args[1] === "add") {
        remotes.set(args[2]!, args[3]!);
        return ok({ exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    };
    const parent = { hostname: "github.com", nameWithOwner: "original/project" };
    const fork = { hostname: "github.com", nameWithOwner: "me/fork" };
    expect(await ensureForkParentRemote(git, "/repo", parent, fork)).toEqual(ok(undefined));
    expect(remotes.get("upstream")).toBe("git@github.com:original/project.git");
    expect(await ensureForkParentRemote(git, "/repo", parent, fork)).toEqual(ok(undefined));
    expect(commands.filter(([command, action]) => command === "remote" && action === "add"))
      .toHaveLength(1);
  });

  it("leaves equal tips alone and fetches only changed tracked and fork-source branches", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwrgit-auto-remote-"));
    const origin = join(root, "origin.git");
    const source = join(root, "source.git");
    const writer = join(root, "writer");
    const local = join(root, "local");
    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "clone", origin, writer);
    git(writer, "config", "user.name", "Test");
    git(writer, "config", "user.email", "test@example.com");
    git(writer, "config", "core.autocrlf", "false");
    writeFileSync(join(writer, "first.txt"), "first\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "first");
    git(writer, "push", "-u", "origin", "main");
    git(root, "clone", "--bare", origin, source);
    git(root, "clone", origin, local);
    git(local, "remote", "add", "upstream", source);
    git(local, "fetch", "upstream");

    const commands: string[][] = [];
    const recordingGit: GitExec = (args, cwd, options) => {
      commands.push(args);
      return systemGit(args, cwd, options);
    };
    let fetched = 0;
    const check = () => checkSelectedRemoteTips(
      recordingGit, local, "main", null, () => undefined, () => { fetched += 1; }
    );
    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(commands.filter(([name]) => name === "fetch")).toHaveLength(0);

    writeFileSync(join(writer, "second.txt"), "second\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "second");
    git(writer, "push", "origin", "main");
    writeFileSync(join(writer, "third.txt"), "third\n");
    git(writer, "add", ".");
    git(writer, "commit", "-m", "third");
    git(writer, "remote", "add", "upstream", source);
    git(writer, "push", "upstream", "main");

    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(fetched).toBe(2);
    expect(commands.filter(([name]) => name === "fetch")).toEqual([
      ["fetch", "--no-tags", "--progress", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["fetch", "--no-tags", "--progress", "upstream", "+refs/heads/main:refs/remotes/upstream/main"]
    ]);
    expect(git(local, "rev-list", "--count", "HEAD..refs/remotes/origin/main")).toBe("1");
    expect(git(local, "rev-list", "--count", "HEAD..refs/remotes/upstream/main")).toBe("2");
    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(fetched).toBe(2);
    git(source, "config", "receive.denyDeleteCurrent", "ignore");
    git(writer, "push", "upstream", "--delete", "main");
    expect(await check()).toEqual({ ok: true, value: "checked" });
    expect(fetched).toBe(3);
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/remotes/upstream/main"))
      .toBe("");
  });
});
