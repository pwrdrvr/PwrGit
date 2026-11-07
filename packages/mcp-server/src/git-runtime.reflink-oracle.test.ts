import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dugite from "dugite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledGitEnvironment } from "./git-runtime.js";

type Setting = "true" | "false" | null;
const SETTINGS: Setting[] = [null, "true", "false"];
const SWITCH: Array<boolean | undefined> = [undefined, true, false];
const section = (value: Setting): string => (value === null ? "" : `[checkout]\n\treflink = ${value}\n`);

/**
 * Git is the oracle. PwrGit writes its copy-on-write switch into the
 * bundle's system config, after the include of the runtime's own config
 * (runtime .2's forces `reflink = true`). Rule: the repository's config
 * wins, then the user's global config, then PwrGit's switch, then whatever
 * the runtime ships; with none of them it is unset.
 *
 * The space is 81 cases, so every one runs: a random sample of 40 reached
 * the deciding case (runtime set, switch opposite, nothing above them) too
 * rarely to catch the switch written before the include.
 */
describe("checkout.reflink as Git reads it, for every layer that can set it", () => {
  let root: string;
  let work: string;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-reflink-layers-")));
    work = join(root, "repo");
    mkdirSync(work);
    const init = await dugite.exec(["init", "-q"], work, { env: { GIT_CONFIG_NOSYSTEM: "1", HOME: root } });
    expect(init.exitCode).toBe(0);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lets repository, global, switch and runtime decide in that order", { timeout: 60_000 }, async () => {
    const repoConfig = join(work, ".git", "config");
    const baseConfig = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";
    let run = 0;
    const failures: string[] = [];
    for (const runtime of SETTINGS) {
      for (const pwrgit of SWITCH) {
        // One generated system config per runtime × switch pair.
        const dir = join(root, String((run += 1)));
        const bundle = join(dir, "runtime");
        mkdirSync(join(bundle, "etc"), { recursive: true });
        writeFileSync(join(bundle, "etc", "gitconfig"), section(runtime));
        const configDirectory = join(dir, "generated");
        mkdirSync(configDirectory);
        const { GIT_CONFIG_SYSTEM } = bundledGitEnvironment(bundle, {}, {
          configDirectory,
          platform: "linux",
          searchPath: "",
          ...(pwrgit === undefined ? {} : { checkoutReflink: pwrgit })
        });
        for (const global of SETTINGS) {
          for (const repo of SETTINGS) {
            const globalFile = join(dir, `global-${String(global)}`);
            writeFileSync(globalFile, section(global));
            writeFileSync(repoConfig, baseConfig + section(repo));
            // Only the config files are under test; Dugite's own Git reads them.
            const read = await dugite.exec(["config", "--get", "checkout.reflink"], work, {
              env: { GIT_CONFIG_SYSTEM, GIT_CONFIG_GLOBAL: globalFile, HOME: dir }
            });
            const actual = read.stdout.trim() === "" ? null : read.stdout.trim();
            const expected = repo ?? global ?? (pwrgit === undefined ? null : String(pwrgit)) ?? runtime;
            if (actual !== expected) {
              failures.push(`runtime=${runtime} switch=${String(pwrgit)} global=${global} repo=${repo}: Git read ${actual}, expected ${expected}`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
