import { createRoot } from "react-dom/client";
import { ok, type GitReflinkStatus, type MaintenanceRepo, type MaintenanceRepoResult, type ReshareWorktreeResult } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { MaintenanceDialog } from "../../../src/renderer/src/features/sidebar/MaintenanceDialog";
import { CLONES_ONLY_PLAN } from "../../../src/renderer/src/features/sidebar/MaintenancePlan";

// Combined maintenance's Clones step with worktrees Git could not re-share
// ("Maintenance Continues Past Errors - UX Review", turn 4). All contrived:
// invented repositories, paths and counts. The docs-site error is the text
// Git prints for a worktree whose .git file points into a moved repository.
const repo = (name: string): MaintenanceRepo => ({ id: name, name, path: `/Users/dana/src/${name}`, profileId: "demo", profileName: "Demo" });
const MiB = 1024 * 1024;
const done = (name: string, branch: string, files: number, bytes: number): ReshareWorktreeResult => ({
  worktreeId: `${name}:${branch}`, path: `/Users/dana/src/${name}-worktrees/${branch.split("/").pop()}`, branch,
  outcome: "reshared", message: `${files.toLocaleString("en-US")} files re-shared.`,
  reshared: files, alreadyShared: 0, skipped: 0, failed: 0, sharedBytes: bytes
});
const failed = (name: string, branch: string, extra: Partial<ReshareWorktreeResult>): ReshareWorktreeResult => ({
  worktreeId: `${name}:${branch}`, path: `/Users/dana/src/${name}-worktrees/${branch.split("/").pop()}`, branch,
  outcome: "failed", message: "", reshared: 0, alreadyShared: 0, skipped: 0, failed: 0, sharedBytes: null, ...extra
});
const fatal = (name: string, branch: string): string =>
  `fatal: gitfile does not point to a valid repository: /Users/dana/src/${name}-worktrees/${branch.split("/").pop()}/.git`;
const broken = (name: string, branch: string): ReshareWorktreeResult =>
  failed(name, branch, { message: fatal(name, branch), gitError: fatal(name, branch), exitCode: 128 });
const cloneError = "error: could not clone 'assets/hero.webp': Operation not permitted";
const results = (many: boolean): MaintenanceRepoResult[] => {
  const docs = [done("docs-site", "docs/api-index", 418, 96 * MiB), broken("docs-site", "docs/refresh-guides"),
    ...(many ? [broken("docs-site", "docs/changelog")] : [])];
  const lumen = [done("lumen-api", "feat/rate-limits", 212, 140 * MiB),
    failed("lumen-api", "agent/quiet-heron", { message: `3 files re-shared · 2 files failed. ${cloneError}`, gitError: cloneError, exitCode: 1, reshared: 3, failed: 2 })];
  const orbit = many ? [broken("orbit-deploy", "feature/route-cache"), broken("orbit-deploy", "agent/brisk-otter"), broken("orbit-deploy", "agent/calm-finch")] : [];
  const row = (name: string, worktrees: ReshareWorktreeResult[]): MaintenanceRepoResult => {
    const bad = worktrees.filter((wt) => wt.outcome === "failed").length;
    const files = worktrees.reduce((sum, wt) => sum + wt.reshared, 0);
    return {
      repo: repo(name), outcome: bad === worktrees.length ? "failed" : "partial",
      message: `main up to date · ${worktrees.length} worktrees · ${files > 0 ? `${files.toLocaleString("en-US")} files re-shared` : "nothing new to share"} · ${bad} failed.`,
      reshare: { main: { outcome: "up_to_date", branch: "main", defaultBranch: "main", message: "main up to date." }, worktrees }
    };
  };
  return [row("docs-site", docs), row("lumen-api", lumen), ...(many ? [row("orbit-deploy", orbit)] : [])];
};
const reflink: GitReflinkStatus = { path: "/Applications/PwrGit.app/Contents/Resources/git/bin/git", version: "git version 2.56.0-dev-pwrgit.3", support: { checkout: true, reshare: true }, enabled: true, active: true };
let many = false;
const copied: string[] = [];
const bridge = {
  profileId: "demo", platform: "darwin",
  dispatch: async (name: string, req: { action?: { kind: string } }) => {
    if (name === "git:reflinkSupport") return ok(reflink);
    if (name === "settings:read") return ok({ general: { maintenanceBranchMode: "auto", branchCleanupPrProof: true, branchCleanupKeepDays: null } });
    if (name === "maintenance:current") return ok(null);
    if (name === "maintenance:run" && req.action?.kind === "reshare")
      return ok({ operationId: "demo", startedAt: "2026-11-19T12:00:00Z", finishedAt: "2026-11-19T12:03:12Z", cancelled: false, results: results(many) });
    return ok(null);
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
// What Copy and Copy all put on the clipboard, for the spec to read.
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";
const root = createRoot(document.getElementById("root")!);
let mounts = 0;
const mount = (): void => root.render(<MaintenanceDialog key={++mounts} profileId="demo" platform="darwin" initialTab="combined"
  initialPlan={CLONES_ONLY_PLAN} autoStart onClose={() => undefined} onRemoveWorktrees={async () => ({ removed: [], keptDirty: [], failed: [] })} />);
const ready = (async () => {
  await Promise.all([
    '400 13px "Geist Sans"', '500 11px "Geist Sans"', '600 13px "Geist Sans"', '700 12px "Geist Sans"',
    '400 11px "Geist Mono"', '500 10px "Geist Mono"', '600 11px "Geist Mono"'
  ].map((font) => document.fonts.load(font)));
  await document.fonts.ready;
  mount();
})();
(window as unknown as { __harness: unknown }).__harness = { ready, copied, many: () => { many = true; mount(); } };
