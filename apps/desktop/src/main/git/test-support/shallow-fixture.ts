import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Fixture Git: the Git on PATH, as the other real-Git suites use. */
export function fixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commit(repo: string, file: string, text: string, message: string): void {
  writeFileSync(join(repo, file), text);
  fixtureGit(repo, "add", file);
  fixtureGit(repo, "commit", "-q", "-m", message);
}

/**
 * A source repository with enough history for depth to matter:
 *
 *   main:  c1 … c12          (tag `old` on c4, annotated `v2` on c11)
 *   side:  c1 … c7, s1, s2   (diverges from main at c7)
 *   topic: c1 … c10, t1      (diverges from main at c10)
 *
 * `file.txt` holds the commit's number on main, so a checkout's contents say
 * exactly which commit it is.
 */
export function createHistorySource(path: string): string {
  mkdirSync(path, { recursive: true });
  fixtureGit(path, "init", "-q", "-b", "main");
  fixtureGit(path, "config", "user.email", "shallow@example.com");
  fixtureGit(path, "config", "user.name", "Shallow Fixture");
  fixtureGit(path, "config", "core.autocrlf", "false");
  fixtureGit(path, "config", "tag.gpgSign", "false");
  fixtureGit(path, "config", "commit.gpgSign", "false");
  for (let n = 1; n <= 12; n += 1) {
    commit(path, "file.txt", `${n}\n`, `c${n}`);
    if (n === 4) fixtureGit(path, "tag", "old");
    if (n === 7) fixtureGit(path, "branch", "side");
    if (n === 10) fixtureGit(path, "branch", "topic");
    if (n === 11) fixtureGit(path, "tag", "-a", "v2", "-m", "v2");
  }
  fixtureGit(path, "switch", "-q", "side");
  commit(path, "side.txt", "s1\n", "s1");
  commit(path, "side.txt", "s2\n", "s2");
  fixtureGit(path, "switch", "-q", "topic");
  commit(path, "topic.txt", "t1\n", "t1");
  fixtureGit(path, "switch", "-q", "main");
  return path;
}

export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** Git's own word for a shallow boundary: `%d` decorates it `grafted`. */
export function graftedCommits(repo: string): Set<string> {
  const out = fixtureGit(repo, "log", "--all", "--format=%H%d");
  return new Set(
    out
      .split("\n")
      .filter((line) => /\bgrafted\b/.test(line))
      .map((line) => line.slice(0, line.indexOf(" ") < 0 ? undefined : line.indexOf(" ")))
  );
}

export function isShallow(repo: string): boolean {
  return fixtureGit(repo, "rev-parse", "--is-shallow-repository") === "true";
}

export function countCommits(repo: string, ref: string): number {
  return Number(fixtureGit(repo, "rev-list", "--count", ref));
}
