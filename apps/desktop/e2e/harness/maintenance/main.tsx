import { createRoot } from "react-dom/client";
import { ok, type MaintenanceAction, type MaintenanceRepoResult } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { MaintenanceDialog } from "../../../src/renderer/src/features/sidebar/MaintenanceDialog";

// Contrived results put a retained branch after more than one receipt page.
const repo = { id: "lumen", name: "lumen-api", path: "/fixtures/lumen-api", profileId: "demo", profileName: "Demo" };
const candidates = Array.from({ length: 27 }, (_, index) => ({
  repoId: repo.id, branch: `finished/task-${index + 1}`, expectedHead: "a1b2c3d4".repeat(5),
  upstream: `refs/remotes/origin/finished/task-${index + 1}`, evidence: "ancestry" as const
}));
const calls: string[] = [];
let allRetained = false;
const bridge = {
  profileId: "demo", platform: "darwin",
  dispatch: async (name: string, req: { action?: MaintenanceAction }) => {
    if (name === "settings:read") return ok({ general: { maintenanceBranchMode: "auto", branchCleanupPrProof: true, branchCleanupKeepDays: null } });
    if (name === "repo:list") return ok([repo]);
    if (name === "maintenance:run" && req.action !== undefined) {
      calls.push(req.action.kind);
      const result: MaintenanceRepoResult = req.action.kind === "scan-branches"
        ? { repo, outcome: "success", message: "27 finished branches", candidates }
        : req.action.kind === "delete-branches"
          ? { repo, outcome: allRetained ? "failed" : "partial", message: allRetained ? "0 local branches deleted; 27 retained." : "26 local branches deleted; 1 retained.", branches: candidates.map((branch, index) => ({
            branch: branch.branch, head: branch.expectedHead, deleted: index < 26 && !allRetained,
            message: index < 26 && !allRetained ? "Deleted local branch." : "The branch changed or is no longer eligible. Review it again; nothing was deleted."
          })) }
          : { repo, outcome: "success", message: "Collected", beforeBytes: 90 * 1024 * 1024, afterBytes: 60 * 1024 * 1024 };
      return ok({ operationId: "demo", startedAt: "2026-11-01T12:00:00Z", finishedAt: "2026-11-01T12:00:02Z", cancelled: false, results: [result] });
    }
    return ok(null);
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";
const ready = (async () => {
  await Promise.all(['400 13px "Geist Sans"', '600 13px "Geist Sans"', '500 12px "Geist Mono"'].map((font) => document.fonts.load(font)));
  await document.fonts.ready;
  createRoot(document.getElementById("root")!).render(<MaintenanceDialog profileId="demo" platform="darwin"
    onClose={() => undefined} onRemoveWorktrees={async () => ({ removed: [], keptDirty: [], failed: [] })} />);
})();
(window as unknown as { __harness: unknown }).__harness = { ready, calls, retainAll: () => { allRetained = true; } };
