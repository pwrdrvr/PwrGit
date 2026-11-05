// Which Git runs, across any sequence of Settings choices. Model: one choice
// at a time (installed path, downloaded build, or bundle), installed >
// managed > bundled when both are stored, and the build being left is always
// the one rollback offers. (Installing never chooses: managed-git-service.test.)
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import {
  activeGitPath,
  execGit,
  gitLaunch,
  holdGitUntil,
  installedGitEnvironment,
  useInstalledGit,
  useManagedGit
} from "./dugite";
import { selectionPatch } from "./runtime-status";

type Stored = { gitPath?: string | undefined; managedGit?: { selected?: string | undefined; previous?: string | undefined } | undefined };
type Command =
  | { kind: "bundled" }
  | { kind: "installed"; path: string }
  | { kind: "managed"; id: string };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.constant({ kind: "bundled" } as const),
  fc.constantFrom("/opt/homebrew/bin/git", "/usr/local/bin/git").map((path) => ({ kind: "installed", path }) as const),
  fc.constantFrom("2.56.0-dev-pwrgit.5-aaaaaaa", "2.56.0-dev-pwrgit.6-bbbbbbb", "2.56.0-dev-pwrgit.7-ccccccc").map((id) => ({ kind: "managed", id }) as const)
);

/** installed > managed > bundled, as launch and `gitLaunch` apply it. */
function effective(stored: Stored): string {
  if (stored.gitPath !== undefined) return `installed:${stored.gitPath}`;
  if (stored.managedGit?.selected !== undefined) return `managed:${stored.managedGit.selected}`;
  return "bundled";
}

describe("selectionPatch", () => {
  test("any sequence: one choice at a time, and rollback is the build just left", () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 30 }), (commands) => {
        let stored: Stored = {};
        let lastLeft: string | undefined;
        for (const next of commands) {
          const before = stored;
          const was = before.managedGit?.selected;
          stored = selectionPatch(before, next);
          const chosen = next.kind === "managed" ? next.id : undefined;
          if (was !== undefined && was !== chosen) lastLeft = was;
          if (lastLeft === chosen) lastLeft = undefined;
          expect(stored.gitPath !== undefined && stored.managedGit?.selected !== undefined).toBe(false);
          expect(effective(stored)).toBe(
            next.kind === "bundled" ? "bundled" : next.kind === "installed" ? `installed:${next.path}` : `managed:${next.id}`
          );
          expect(stored.managedGit?.previous).toBe(lastLeft);
          expect(stored.managedGit?.previous === undefined || stored.managedGit.previous !== stored.managedGit.selected).toBe(true);
        }
      }),
      { numRuns: 500 }
    );
  });

  test("a stored installed path outranks a stored build (a hand-edited file)", () => {
    expect(effective({ gitPath: "/opt/homebrew/bin/git", managedGit: { selected: "2.56.0-dev-pwrgit.5-aaaaaaa" } })).toBe("installed:/opt/homebrew/bin/git");
  });
});

describe("a downloaded build runs as the whole bundle", () => {
  let scratch: string | null = null;
  afterEach(() => {
    useManagedGit(null);
    useInstalledGit(null);
    holdGitUntil(Promise.resolve());
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  });

  // PwrGit offers no build of its own on Windows, whose bundle layout
  // (cmd/git.exe) this would otherwise have to spell.
  test.skipIf(process.platform === "win32")("its own binary, exec path, templates and system config; an installed Git sees none of it", () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-managed-launch-")));
    const build = join(scratch, "versions", "2.56.0-dev-pwrgit.5-aaaaaaa", "darwin-universal");
    mkdirSync(join(build, "bin"), { recursive: true });
    useManagedGit(build);
    const launch = gitLaunch();
    expect(launch.binary).toBe(join(build, "bin", "git"));
    expect(activeGitPath()).toBe(join(build, "bin", "git"));
    expect(launch.env["LOCAL_GIT_DIRECTORY"]).toBe(build);
    expect(launch.env["GIT_EXEC_PATH"]).toBe(join(build, "libexec", "git-core"));
    if (process.platform !== "win32") expect(launch.env["GIT_TEMPLATE_DIR"]).toBe(`${build}/share/git-core/templates`);
    if (process.platform === "linux") expect(launch.env["GIT_SSL_CAINFO"]).toBe(join(build, "ssl", "cacert.pem"));
    const installed = installedGitEnvironment({ ...launch.env }, "/opt/homebrew/bin/git");
    for (const key of ["LOCAL_GIT_DIRECTORY", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR"]) expect(installed[key]).toBeUndefined();
    expect((installed["PATH"] ?? "").split(":").some((entry) => entry.startsWith(build))).toBe(false);
    // An installed Git chosen over it wins.
    useInstalledGit("/opt/homebrew/bin/git");
    expect(gitLaunch().binary).toBe("/opt/homebrew/bin/git");
  });

  test("Git waits for the launch check, and a failed check fails every command by name", async () => {
    let release!: () => void;
    holdGitUntil(new Promise<void>((resolve) => (release = resolve)));
    let settled = false;
    const pending = execGit(["--version"], tmpdir()).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    release();
    expect((await pending).ok).toBe(true);

    holdGitUntil(Promise.reject(new Error("PwrGit’s Git 2.56.0-dev-pwrgit.5-aaaaaaa failed its check at launch (bin/git changed). Choose another Git in Settings › Git.")));
    const refused = await execGit(["--version"], tmpdir());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("spawn_failed");
      expect(refused.error.message).toMatch(/failed its check at launch/);
    }
  });
});
