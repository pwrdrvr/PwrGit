import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundledGitPath,
  configureBundledGitConfig,
  gitExecutionEnvironment,
  gitProcessInvocation,
  noteGitReflinkSupport,
  useInstalledGit,
  useReflinkCheckout
} from "./dugite";

const INSTALLED = ["/opt/a/bin/git", "/opt/b/bin/git"];
const FLAG = ["-c", "checkout.reflink=true"];

/** The last `reflink = …` PwrGit's system config sets, as Git would read it. */
function systemConfigReflink(): string | null {
  const text = readFileSync(gitExecutionEnvironment().GIT_CONFIG_SYSTEM ?? "", "utf8");
  const values = [...text.matchAll(/^\s*reflink\s*=\s*(\S+)\s*$/gm)].map((match) => match[1]!);
  return values.at(-1) ?? null;
}

type Model = { installed: string | null; wanted: boolean; probe: { path: string; capable: boolean } | null };

/**
 * The switch reaches Git two ways: PwrGit's system config for the bundle,
 * `-c` for an installed Git. Rule, after any sequence of runtime switches,
 * Settings toggles and probe answers: the Git in use clones on checkout
 * exactly when the switch is on and the last probe *of that Git* said it can.
 * For the bundle that is always written down, off included, because a
 * runtime's own config may say otherwise; an installed Git gets `-c` only
 * while on and otherwise keeps its own config.
 */
describe("copy-on-write reaches whichever Git runs, for any sequence of changes", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "pwrgit-gitconfig-"));
    configureBundledGitConfig(directory);
  });
  afterAll(() => {
    configureBundledGitConfig(null);
    useInstalledGit(null);
    useReflinkCheckout(false);
    noteGitReflinkSupport("/nowhere", null, { checkout: false, reshare: false });
    rmSync(directory, { recursive: true, force: true });
  });

  it("agrees with the model after every step", () => {
    const step = fc.oneof(
      fc.record({ kind: fc.constant("runtime" as const), installed: fc.constantFrom<string | null>(null, ...INSTALLED) }),
      fc.record({ kind: fc.constant("switch" as const), on: fc.boolean() }),
      fc.record({
        kind: fc.constant("probe" as const),
        path: fc.constantFrom("bundle", ...INSTALLED),
        capable: fc.boolean()
      })
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
        const model: Model = { installed: null, wanted: false, probe: null };
        useInstalledGit(null);
        useReflinkCheckout(false);
        noteGitReflinkSupport("/nowhere", null, { checkout: false, reshare: false });
        for (const action of steps) {
          if (action.kind === "runtime") {
            model.installed = action.installed;
            useInstalledGit(action.installed);
          } else if (action.kind === "switch") {
            model.wanted = action.on;
            useReflinkCheckout(action.on);
          } else {
            const path = action.path === "bundle" ? bundledGitPath() : action.path;
            model.probe = { path, capable: action.capable };
            noteGitReflinkSupport(path, "git version 2.56.0", { checkout: action.capable, reshare: action.capable });
          }
          const active = model.installed ?? bundledGitPath();
          const clones = model.wanted && model.probe?.path === active && model.probe.capable;
          const args = gitProcessInvocation(["switch", "x"], "/w").args;
          if (model.installed === null) {
            expect(args.slice(0, 2)).not.toEqual(FLAG);
            expect(systemConfigReflink()).toBe(String(clones));
          } else {
            expect(args.slice(0, 2)).toEqual(clones ? FLAG : ["-C", "/w"]);
          }
        }
      })
    );
  });
});
