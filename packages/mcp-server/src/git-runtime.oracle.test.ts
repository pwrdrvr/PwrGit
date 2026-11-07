import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dugite from "dugite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledGitEnvironment } from "./git-runtime.js";

// Real Git is the oracle: whatever the user configured must read the same
// through PwrGit's environment as through Dugite's own, however many times the
// environment was built and whichever Pwr app wrapped it first. The space is
// small enough to enumerate, so every case runs.

type Entry = readonly [key: string, value: string];
const USER_SYSTEM: (Entry[] | null)[] = [
  null,
  [["pwrtest.alpha", "one"]],
  [["pwrtest.alpha", "one"], ["pwrtest.alpha", "two"], ["pwrtest.beta", "true"]]
];
const INHERITED_FROM = ["nothing", "pwrgit", "pwragent"] as const;
const LAYERS: { global: Entry[]; local: Entry[] }[] = [
  { global: [], local: [] },
  { global: [["pwrtest.beta", "false"]], local: [] },
  { global: [["pwrtest.beta", "false"]], local: [["pwrtest.alpha", "three"]] }
];
const BUILDS = [1, 2, 3];

function configText(entries: readonly Entry[], prefix = ""): string {
  return prefix + entries.map(([key, value]) => {
    const dot = key.lastIndexOf(".");
    return `[${key.slice(0, dot)}]\n\t${key.slice(dot + 1)} = ${value}\n`;
  }).join("");
}

// Include paths are written unescaped below, which holds for POSIX paths only.
describe.skipIf(process.platform === "win32")("bundled Git system config, against Git itself", () => {
  const bundle = dugite.resolveEmbeddedGitDir();
  const git = dugite.resolveGitBinary(bundle);
  let root: string;
  let repo: string;
  let base: NodeJS.ProcessEnv;
  let otherBundleConfig: string;
  let saved: string | undefined;
  let run = 0;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-config-oracle-")));
    base = { ...process.env, HOME: join(root, "home") };
    for (const key of ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "XDG_CONFIG_HOME"]) {
      delete base[key];
    }
    // bundledGitEnvironment also reads the process environment.
    saved = process.env.GIT_CONFIG_SYSTEM;
    delete process.env.GIT_CONFIG_SYSTEM;
    repo = join(root, "repo");
    expect(spawnSync(git, ["init", "-q", repo], { env: { ...base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).status).toBe(0);
    // Another Pwr app's bundled Git, which its generated config includes.
    const otherBundle = join(root, "OtherApp", "git");
    mkdirSync(join(otherBundle, "libexec", "git-core"), { recursive: true });
    mkdirSync(join(otherBundle, "etc"));
    otherBundleConfig = join(otherBundle, "etc", "gitconfig");
    writeFileSync(otherBundleConfig, "[pwrtest]\n\talpha = other-bundle\n");
  });

  afterAll(() => {
    if (saved !== undefined) process.env.GIT_CONFIG_SYSTEM = saved;
    rmSync(root, { recursive: true, force: true });
  });

  /** Every pwrtest value, in the order Git reads them. */
  function readConfig(env: NodeJS.ProcessEnv): string[] {
    const result = spawnSync(git, ["config", "--get-regexp", "^pwrtest\\."], { cwd: repo, encoding: "utf8", env, timeout: 10_000 });
    expect(result.status === 0 || result.status === 1, result.stderr).toBe(true);
    return result.stdout.split("\n").filter(Boolean);
  }

  const cases = USER_SYSTEM.flatMap((userSystem) => INHERITED_FROM.flatMap((inheritedFrom) =>
    LAYERS.flatMap((layers) => BUILDS.map((builds) => ({ userSystem, inheritedFrom, layers, builds })))));

  it(`reads the user's system, global and repository config as Dugite's Git does (${cases.length} cases)`, () => {
    for (const { userSystem, inheritedFrom, layers, builds } of cases) {
      const dir = join(root, `run-${run += 1}`);
      mkdirSync(dir);
      const global = join(dir, "global");
      writeFileSync(global, configText(layers.global));
      writeFileSync(join(repo, ".git", "config"), configText(layers.local, "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"));
      let userConfig: string | undefined;
      if (userSystem !== null) {
        userConfig = join(dir, "user system config");
        writeFileSync(userConfig, configText(userSystem));
      }
      const source: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: global };
      if (inheritedFrom === "nothing") {
        if (userConfig !== undefined) source.GIT_CONFIG_SYSTEM = userConfig;
      } else {
        // A generated file from another data directory: PwrGit's from a dev
        // profile, or PwrAgent's from its terminal, around its own bundle.
        const wrapper = join(dir, `${inheritedFrom}-gitconfig`);
        const inner = userConfig ?? (inheritedFrom === "pwragent" ? otherBundleConfig : join(bundle, "etc", "gitconfig"));
        const marker = inheritedFrom === "pwrgit" ? "PwrGit" : "PwrAgent";
        writeFileSync(wrapper, `# Written by ${marker}: defaults\n[credential]\n\thelper = fixture\n[include]\n\tpath = "${inner}"\n`);
        source.GIT_CONFIG_SYSTEM = wrapper;
      }

      let built: NodeJS.ProcessEnv = source;
      for (let build = 0; build < builds; build += 1) {
        built = bundledGitEnvironment(undefined, built, { configDirectory: join(root, "data", "git"), platform: "linux" });
      }
      const actual = readConfig(dugite.setupEnvironment(built, base).env);
      const expected = readConfig(dugite.setupEnvironment({}, {
        ...base,
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_SYSTEM: userConfig ?? join(bundle, "etc", "gitconfig")
      }).env);
      expect(actual, JSON.stringify({ userSystem, inheritedFrom, layers, builds })).toEqual(expected);
    }
  });
});
