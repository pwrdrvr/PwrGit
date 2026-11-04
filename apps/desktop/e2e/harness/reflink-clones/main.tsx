import { createRoot, type Root } from "react-dom/client";
import {
  ok,
  type GitReflinkStatus,
  type GitRuntimeStatus,
  type MaintenanceProgress,
  type MaintenanceRepo,
  type MaintenanceRepoResult,
  type MaintenanceSummary
} from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { MaintenanceDialog } from "../../../src/renderer/src/features/sidebar/MaintenanceDialog";
import { GitRuntimeSettings } from "../../../src/renderer/src/features/settings/GitRuntimeSettings";

// All contrived: invented repositories, paths and counts.
const BUNDLED = "/Applications/PwrGit.app/Contents/Resources/git/bin/git";
const HOMEBREW = "/opt/homebrew/bin/git";
const runtime = (path: string): GitRuntimeStatus => ({
  active: path === BUNDLED ? "bundled" : "installed",
  path,
  keychainHelper: "/opt/homebrew/Cellar/git/2.56.0/libexec/git-core/git-credential-osxkeychain",
  candidates: [
    { path: BUNDLED, source: "bundled", git: "git version 2.56.0-dev-pwrgit.2", lfs: "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)", problem: null, reflink: { checkout: true, reshare: true } },
    { path: HOMEBREW, source: "homebrew", git: "git version 2.56.0", lfs: "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)", problem: null, reflink: { checkout: false, reshare: false } }
  ]
});
const capable: GitReflinkStatus = { path: BUNDLED, version: "git version 2.56.0-dev-pwrgit.2", support: { checkout: true, reshare: true }, enabled: true, active: true };
const homebrew: GitReflinkStatus = { path: HOMEBREW, version: "git version 2.56.0", support: { checkout: false, reshare: false }, enabled: true, active: false };

const repo = (name: string): MaintenanceRepo => ({ id: name, name, path: `/Users/demo/src/${name}`, profileId: "demo", profileName: "Demo" });
const repos = ["atlas", "lumen-api", "lumen-web", "notes", "tidepool", "zephyr"].map(repo);
// A second clone of atlas elsewhere: same name, told apart by path.
repos.push({ ...repo("atlas"), id: "atlas-fork", path: "/Users/demo/forks/atlas" });
const MiB = 1024 * 1024;
const worktree = (name: string, branch: string, files: number, skipped: number, bytes: number, why = "changed") => ({
  worktreeId: `${name}:${branch}`,
  path: `/Users/demo/.worktrees/${name}/${branch.replaceAll("/", "-")}`,
  branch,
  outcome: files > 0 ? ("reshared" as const) : ("already_shared" as const),
  message: files > 0
    ? `${files.toLocaleString("en-US")} files re-shared${skipped > 0 ? ` · ${skipped} left as they are (${skipped} ${why})` : ""}.`
    : "1,204 already shared.",
  reshared: files, alreadyShared: files > 0 ? 0 : 1204, skipped, failed: 0, sharedBytes: bytes
});
const results: MaintenanceRepoResult[] = [
  { repo: repos[0]!, outcome: "success", message: "Main checkout left: it is on release/2.4, not main · 2 worktrees · 1,880 files re-shared.",
    reshare: { main: { outcome: "left", branch: "release/2.4", defaultBranch: "main", message: "Main checkout left: it is on release/2.4, not main." },
      worktrees: [worktree("atlas", "fix/tile-cache", 1210, 4, 61 * MiB), worktree("atlas", "feat/vector-layer", 670, 31, 27 * MiB, "differ from the main checkout")] } },
  { repo: repos[1]!, outcome: "success", message: "main fast-forwarded · 3 worktrees · 9,402 files re-shared.",
    reshare: { main: { outcome: "updated", branch: "main", defaultBranch: "main", message: "main fast-forwarded." },
      worktrees: [worktree("lumen-api", "feat/rate-limits", 3810, 2, 260 * MiB), worktree("lumen-api", "fix/retry-jitter", 3402, 0, 231 * MiB), worktree("lumen-api", "spike/grpc", 2190, 118, 149 * MiB, "changed")] } },
  { repo: repos[2]!, outcome: "success", message: "main up to date · 1 worktree · 4,120 files re-shared.",
    reshare: { main: { outcome: "up_to_date", branch: "main", defaultBranch: "main", message: "main up to date." },
      worktrees: [worktree("lumen-web", "feat/onboarding", 4120, 9, 212 * MiB)] } },
  { repo: repos[3]!, outcome: "skipped", message: "No linked worktrees.", reshare: { main: { outcome: "not_requested", message: "Main checkout not updated." }, worktrees: [] } },
  { repo: repos[4]!, outcome: "success", message: "main up to date · 2 worktrees · nothing new to share.",
    reshare: { main: { outcome: "up_to_date", branch: "main", defaultBranch: "main", message: "main up to date." },
      worktrees: [worktree("tidepool", "feat/alerts", 0, 0, 0), worktree("tidepool", "chore/deps", 0, 0, 0)] } },
  { repo: repos[5]!, outcome: "partial", message: "Main checkout left: it has uncommitted changes · 2 worktrees · 940 files re-shared · 1 failed.",
    reshare: { main: { outcome: "left", branch: "main", defaultBranch: "main", message: "Main checkout left: it has uncommitted changes." },
      worktrees: [worktree("zephyr", "feat/importer", 940, 3, 38 * MiB),
        { worktreeId: "zephyr:wip", path: "/Users/demo/.worktrees/zephyr/wip", branch: "wip", outcome: "failed", message: "fatal: Unable to create '/Users/demo/src/zephyr/.git/worktrees/wip/index.lock': File exists.", reshared: 0, alreadyShared: 0, skipped: 0, failed: 0, sharedBytes: null }] } },
  { repo: repos[6]!, outcome: "skipped", message: "No linked worktrees.", reshare: { main: { outcome: "not_requested", message: "Main checkout not updated." }, worktrees: [] } }
];

let reflink = capable;
let finish: ((summary: MaintenanceSummary) => void) | null = null;
const listeners = new Set<(event: MaintenanceProgress) => void>();
let operationId = "";
const bridge = {
  profileId: "demo",
  platform: "darwin",
  dispatch: async (name: string, req: { path?: string | null; operationId?: string }) => {
    if (name === "git:runtimeStatus") return ok(runtime(reflink.path));
    if (name === "git:reflinkSupport") return ok(reflink);
    if (name === "settings:read") return ok({ general: { maintenanceBranchMode: "review", branchCleanupPrProof: true, branchCleanupKeepDays: 7 } });
    if (name === "maintenance:run") {
      operationId = req.operationId ?? "";
      return new Promise((resolve) => {
        finish = (summary) => resolve(ok(summary));
      });
    }
    return ok(null);
  },
  on: (_channel: string, listener: (event: MaintenanceProgress) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";

let root: Root | null = null;
const emit = (event: Omit<MaintenanceProgress, "operationId" | "profileId">): void => {
  for (const listener of listeners) listener({ ...event, operationId, profileId: "demo" });
};
const harness = {
  ready: (async () => {
    await Promise.all([
      '400 13px "Geist Sans"', '500 11px "Geist Sans"', '600 13px "Geist Sans"', '700 12px "Geist Sans"',
      '400 11px "Geist Mono"', '500 10px "Geist Mono"', '600 11px "Geist Mono"'
    ].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  })(),
  mount(view: "settings-pwrgit" | "settings-homebrew" | "settings-before" | "clones" | "clones-unavailable"): void {
    root?.unmount();
    root = createRoot(document.getElementById("root")!);
    reflink = view === "settings-homebrew" || view === "clones-unavailable" ? homebrew : capable;
    if (view.startsWith("settings")) {
      root.render(
        <div className="settings-harness" style={{ width: 760, padding: 20 }}>
          {view === "settings-before" ? <GitRuntimeSettings /> : (
            <GitRuntimeSettings reflinkCheckout={{ enabled: true, saving: false, onChange: () => undefined }} />
          )}
        </div>
      );
      return;
    }
    root.render(<MaintenanceDialog profileId="demo" platform="darwin" initialTab="clones"
      onClose={() => undefined} onRemoveWorktrees={async () => ({ removed: [], keptDirty: [], failed: [] })} />);
  },
  /** Mid-run: three repositories done, two running, one queued. */
  progress(): void {
    emit({ phase: "starting", repos });
    for (const index of [0, 2, 3]) {
      emit({ phase: "repo_started", repo: repos[index]! });
      emit({ phase: "repo_completed", repo: repos[index]!, result: results[index]! });
    }
    emit({ phase: "repo_started", repo: repos[1]! });
    emit({ phase: "repo_progress", repo: repos[1]!, detail: "Worktree 2 of 3 · fix/retry-jitter" });
    emit({ phase: "repo_started", repo: repos[5]! });
    emit({ phase: "repo_progress", repo: repos[5]!, detail: "Updating the main checkout: origin: fetching…" });
  },
  finish(): void {
    finish?.({ operationId, startedAt: "2026-11-04T12:00:00Z", finishedAt: "2026-11-04T12:02:14Z", cancelled: false, results });
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
