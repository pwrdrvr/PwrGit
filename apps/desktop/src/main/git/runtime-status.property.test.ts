import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeGitPath,
  bundledGitPath,
  noteGitReflinkSupport,
  reflinkCheckoutActive,
  useInstalledGit,
  useReflinkCheckout,
  type GitLaunch
} from "./dugite";
import { refreshActiveGitReflink, selectGitRuntime, type GitDiscoveryDeps } from "./runtime-status";

const CAPABLE_USAGE = "usage: git worktree add [-f] [--[no-]reflink] <path>\n   or: git worktree reflink [--porcelain]";
const PLAIN_USAGE = "usage: git worktree add [-f] <path>";

/**
 * Copy-on-write checkout follows the Git in use. Settings can switch Git
 * while a launch-time probe is still out, and probes answer in any order.
 * Rules:
 * - once everything has answered, the flag is on exactly when the switch is
 *   on and the Git in use can clone;
 * - at no point is the flag on for a Git that can't.
 */
describe("copy-on-write follows the Git in use, for any switches and probe order", () => {
  afterEach(() => {
    useInstalledGit(null);
    useReflinkCheckout(false);
    noteGitReflinkSupport("/nowhere", null, { checkout: false, reshare: false });
  });

  it("settles on the Git in use and never runs ahead of its probe", async () => {
    const installed = ["/opt/a/bin/git", "/opt/b/bin/git"];
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.record({ bundle: fc.boolean(), a: fc.boolean(), b: fc.boolean() }),
        fc.boolean(),
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("select" as const), target: fc.constantFrom<string | null>(null, ...installed) }),
            fc.record({ kind: fc.constant("refresh" as const) }),
            fc.record({ kind: fc.constant("switch" as const), on: fc.boolean() })
          ),
          { minLength: 1, maxLength: 6 }
        ),
        async (s, capable, initiallyOn, actions) => {
          useInstalledGit(null);
          noteGitReflinkSupport("/nowhere", null, { checkout: false, reshare: false });
          let wanted = initiallyOn;
          useReflinkCheckout(wanted);
          const canClone = (path: string): boolean =>
            path === bundledGitPath() ? capable.bundle : path === installed[0] ? capable.a : capable.b;
          const ranAhead: string[] = [];
          const check = (): void => {
            if (reflinkCheckoutActive() && !canClone(activeGitPath())) ranAhead.push(activeGitPath());
          };
          const deps: GitDiscoveryDeps = {
            platform: "darwin",
            home: "/Users/fixture",
            searchPath: () => "/usr/bin",
            executable: async () => true,
            realpath: async (path) => path,
            developerDirectory: async () => null,
            probe: async (launch: GitLaunch, args: string[]) => {
              const stdout =
                args[0] === "--version"
                  ? "git version 2.56.0"
                  : args[0] === "lfs"
                    ? "git-lfs/3.7.1"
                    : canClone(launch.binary) ? CAPABLE_USAGE : PLAIN_USAGE;
              const answer = await s.schedule(Promise.resolve({ ok: true, stdout }), `${launch.binary} ${args[0]}`);
              check();
              return answer;
            }
          };
          const settings = { update: vi.fn() };
          // Launch probes the Git in use; everything else races it.
          const launch = refreshActiveGitReflink(deps).then(check);
          const running = actions.map((action) => {
            if (action.kind === "switch") {
              wanted = action.on;
              useReflinkCheckout(action.on);
              check();
              return Promise.resolve();
            }
            return action.kind === "select"
              ? selectGitRuntime(settings, action.target, deps).then(check)
              : refreshActiveGitReflink(deps).then(check);
          });
          await s.waitFor(Promise.all([launch, ...running]));
          await s.waitIdle();
          expect(ranAhead).toEqual([]);
          expect(reflinkCheckoutActive()).toBe(wanted && canClone(activeGitPath()));
        }
      ),
      { numRuns: 200 }
    );
  });
});
