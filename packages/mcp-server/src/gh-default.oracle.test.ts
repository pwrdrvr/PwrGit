import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { resolveGhDefaultRepository, type GhRemoteInput } from "./gh-default.js";

// The GitHub CLI itself is the oracle: `gh browse -n` prints the base
// repository's URL, resolved exactly as `gh pr create` resolves it. It needs a
// signed-in gh and the network (it reads the repository), so it runs only
// when asked: PWRGIT_GH_ORACLE=1 pnpm vitest run gh-default.oracle
const enabled = process.env.PWRGIT_GH_ORACLE === "1";

// Real public repositories, so gh's API read succeeds.
const REPOS = ["pwrdrvr/PwrDisk", "tobi/disktree", "cli/cli", "pwrdrvr/PwrGit"];
const NAMES = ["origin", "upstream", "github", "pwrdrvr", "fork", "zeta"];

describe.skipIf(!enabled)("gh default repository, against gh", () => {
  const root = enabled ? realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-gh-oracle-"))) : "";
  let run = 0;
  afterAll(() => { if (root !== "") rmSync(root, { recursive: true, force: true }); });

  it("picks the repository gh picks, with and without gh repo set-default", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }).chain((names) =>
          fc.tuple(
            fc.tuple(...names.map((name) => fc.tuple(fc.constant(name), fc.constantFrom(...REPOS)))),
            fc.option(fc.constantFrom(...names), { freq: 2 })
          )
        ),
        ([remotes, resolvedOn]) => {
          const repo = join(root, `r${run++}`);
          execFileSync("git", ["init", "-q", repo]);
          for (const [name, path] of remotes) {
            execFileSync("git", ["remote", "add", name, `git@github.com:${path}.git`], { cwd: repo });
          }
          if (resolvedOn !== null) {
            execFileSync("git", ["config", `remote.${resolvedOn}.gh-resolved`, "base"], { cwd: repo });
          }
          const gh = spawnSync("gh", ["browse", "-n"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          expect(gh.status, gh.stderr).toBe(0);
          const ghPicked = gh.stdout.trim().replace("https://github.com/", "");

          const inputs: GhRemoteInput[] = remotes.map(([name, path]) => ({
            name, host: "github.com", repository: path, github: true,
            resolved: name === resolvedOn ? "base" : null
          }));
          expect(resolveGhDefaultRepository(inputs).repository?.toLowerCase()).toBe(ghPicked.toLowerCase());
        }
      ),
      { numRuns: 25 }
    );
  }, 120_000);
});
