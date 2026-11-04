import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { err, ok, type Repo } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { guardedSwitchBranch } from "../../../src/renderer/src/features/shell/branchSwitch";
import { DialogHost } from "../../../src/renderer/src/features/shell/DialogHost";
import { ToastHost } from "../../../src/renderer/src/features/shell/ToastHost";

/**
 * The real branch-switch prompts and the "your changes are waiting" toast,
 * driven through the real `guardedSwitchBranch` against a fake preload
 * bridge. Every name is contrived: a `lumen-api` checkout on `main` with three
 * uncommitted files, switching to `feature/rate-cards`, which has its own
 * `src/pricing/quote.ts`. `switch-dialogs.spec.ts` drives it through
 * `window.__harness`.
 */

const WORKTREE = "wt-lumen";
const LEFT_STASH = "4f1c2d9e7a3b5c6d8e9f0a1b2c3d4e5f6a7b8c9d";
const FILES = ["src/pricing/quote.ts", "src/pricing/quote.test.ts", "docs/rates.md"];

/** Which world the bridge answers for. */
let scene: "dirty" | "return" = "dirty";
const calls: { name: string; req: unknown }[] = [];

const bridge = {
  profileId: "profile-harness",
  platform: "darwin",
  appearance: { theme: "light", resolvedTheme: "light" },
  dispatch: async (name: string, req: unknown): Promise<unknown> => {
    calls.push({ name, req });
    const changes = (req as { changes?: string } | null)?.changes;
    switch (name) {
      case "worktree:readDirty":
        return ok({ dirty: scene === "dirty" ? FILES.length : 0 });
      case "changes:list":
        return ok({
          staged: [],
          unstaged: FILES.map((path) => ({ path })),
          untracked: []
        });
      case "branch:switch":
        // A plain switch — "bring my changes" — refuses over the one file the
        // destination has its own version of; merge and leave go through.
        if (scene === "dirty" && changes === undefined) {
          return err({
            kind: "repo",
            code: "switch_would_overwrite",
            message:
              "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/pricing/quote.ts",
            paths: ["src/pricing/quote.ts"]
          });
        }
        return ok({ carried: changes === "merge", left: changes === "leave" });
      case "stash:list":
        return ok(
          scene === "return"
            ? [
                {
                  selector: "stash@{0}",
                  hash: LEFT_STASH,
                  occurrenceCount: 1,
                  shortHash: LEFT_STASH.slice(0, 7),
                  baseHash: "0".repeat(40),
                  branch: "main",
                  subject: "On main: pwrgit: left on main",
                  name: "pwrgit: left on main",
                  kind: "ordinary",
                  createdAt: "2026-10-28T16:20:00Z"
                }
              ]
            : []
        );
      case "stash:details":
        return ok({
          files: FILES.map((path) => ({ path, additions: 4, deletions: 1 })),
          additions: 12,
          deletions: 3
        });
      case "stash:pop":
        return ok(null);
      default:
        return err({ kind: "unknown", code: "harness", message: `${name} is not faked` });
    }
  },
  on: () => () => undefined,
  getAppMenuModel: async () => [],
  popupAppMenu: () => undefined,
  runWindowControl: async () => undefined,
  readWindowFrameState: async () => null,
  onWindowFrameState: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.setAttribute("data-theme", "light");
document.documentElement.dataset["platform"] = "darwin";

/** Just enough of a repository for a toast's subject chip to name it. */
const REPOS = [
  { id: "repo-lumen", name: "lumen-api", worktrees: [{ id: WORKTREE }] }
] as unknown as Repo[];

const noop = (): void => undefined;

const harness = {
  ready: (async () => {
    await Promise.all(
      [
        '400 13px "Geist Sans"',
        '500 13px "Geist Sans"',
        '600 13px "Geist Sans"',
        '600 15px "Geist Sans"',
        '400 12px "Geist Mono"'
      ].map((font) => document.fonts.load(font))
    );
    await document.fonts.ready;
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ToastHost repos={REPOS} onReveal={noop} />
        <DialogHost />
      </StrictMode>
    );
  })(),
  /** Switch `lumen-api` to `feature/rate-cards` (dirty) or back to `main`
   *  (clean, with changes left there). Not awaited: the prompts it raises are
   *  answered from outside. */
  start(next: "dirty" | "return"): void {
    scene = next;
    void guardedSwitchBranch({
      worktreeId: WORKTREE,
      worktreeLabel: "lumen-api",
      fromBranch: next === "dirty" ? "main" : "feature/rate-cards",
      branch: next === "dirty" ? "feature/rate-cards" : "main"
    });
  },
  calls: () => calls
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
