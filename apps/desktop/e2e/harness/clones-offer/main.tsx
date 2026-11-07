import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, type ClonesOffer, type GitReflinkStatus, type MaintenanceAction, type MaintenanceRepoResult } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { MaintenanceDialog } from "../../../src/renderer/src/features/sidebar/MaintenanceDialog";
import { CLONES_ONLY_PLAN } from "../../../src/renderer/src/features/sidebar/MaintenancePlan";
import { useClonesOffer } from "../../../src/renderer/src/features/sidebar/clones-offer";
import { ToastHost } from "../../../src/renderer/src/features/shell/ToastHost";

// All contrived: invented repositories, paths, versions and sizes.
const GIB = 1024 * 1024 * 1024;
const capable: GitReflinkStatus = { path: "/Applications/PwrGit.app/Contents/Resources/git/bin/git", version: "git version 2.56.0-dev-pwrgit.4", support: { checkout: true, reshare: true }, enabled: true, active: true };
const homebrew: GitReflinkStatus = { path: "/opt/homebrew/bin/git", version: "git version 2.56.0", support: { checkout: false, reshare: false }, enabled: true, active: false };
const repo = (name: string) => ({ id: name, name, path: `/Users/demo/src/${name}`, profileId: "demo", profileName: "Demo" });
const shared = (name: string, worktrees: number, bytes: number): MaintenanceRepoResult => ({
  repo: repo(name), outcome: "success", message: `main up to date · ${worktrees} worktrees · ${worktrees * 1200} files re-shared.`,
  reshare: { main: { outcome: "up_to_date", branch: "main", defaultBranch: "main", message: "main up to date." },
    worktrees: Array.from({ length: worktrees }, (_, index) => ({
      worktreeId: `${name}:${index}`, path: `/Users/demo/.worktrees/${name}/wt-${index}`, branch: `feat/${name}-${index}`,
      outcome: "reshared" as const, message: "1,200 files re-shared.", reshared: 1200, alreadyShared: 0, skipped: 0, failed: 0,
      sharedBytes: Math.round(bytes / worktrees)
    })) }
});
const results = [shared("lumen-api", 14, 3.02 * GIB), shared("atlas", 6, 1.11 * GIB), shared("tidepool", 9, 1.24 * GIB), shared("zephyr", 12, 0.81 * GIB)];
const offers: Record<string, ClonesOffer> = {
  measured: { kind: "bytes", bytes: 6.32 * GIB, atLeast: false },
  partial: { kind: "bytes", bytes: 2.1 * GIB, atLeast: true },
  files: { kind: "files", files: 3412 }
};

let reflink = capable;
let offer: ClonesOffer | null = null;
const calls: string[] = [];
const bridge = {
  profileId: "demo",
  platform: "darwin",
  dispatch: async (name: string, req: { action?: MaintenanceAction; answer?: string }) => {
    if (name === "git:reflinkSupport") return ok(reflink);
    if (name === "settings:read") return ok({ general: { maintenanceBranchMode: "review", branchCleanupPrProof: true, branchCleanupKeepDays: 7 } });
    if (name === "repo:list") return ok(Array.from({ length: 23 }, (_, index) => ({ id: `r${index}` })));
    if (name === "remote:activities") return ok([]);
    if (name === "app:readUpdateStatus") return ok({ status: "idle" });
    if (name === "maintenance:clonesOffer") return ok(offer);
    if (name === "maintenance:clonesOfferAnswer") calls.push(`answer:${req.answer}`);
    if (name === "maintenance:run" && req.action !== undefined) {
      calls.push(req.action.kind);
      return ok({ operationId: "demo", startedAt: "2026-11-07T12:00:00Z", finishedAt: "2026-11-07T12:02:04Z", cancelled: false, results });
    }
    return ok(null);
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";

const noRemove = async () => ({ removed: [], keptDirty: [], failed: [] });
/** The sidebar's part: the offer hook, the toast stack, and the dialog the
 *  toast's Share files opens. */
function OfferApp() {
  const [open, setOpen] = useState(false);
  useClonesOffer("demo", () => setOpen(true), 0);
  return <>
    {open && <MaintenanceDialog profileId="demo" platform="darwin" onClose={() => setOpen(false)} onRemoveWorktrees={noRemove}
      initialTab="combined" initialPlan={CLONES_ONLY_PLAN} autoStart />}
    <ToastHost repos={[]} onReveal={() => undefined} />
  </>;
}

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all([
      '400 13px "Geist Sans"', '500 11px "Geist Sans"', '600 13px "Geist Sans"', '700 12px "Geist Sans"',
      '400 11px "Geist Mono"', '500 10px "Geist Mono"', '600 11px "Geist Mono"'
    ].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  })(),
  calls,
  mount(view: "plan" | "plan-homebrew" | "offer-measured" | "offer-partial" | "offer-files"): void {
    root?.unmount();
    root = createRoot(document.getElementById("root")!);
    calls.length = 0;
    reflink = view === "plan-homebrew" ? homebrew : capable;
    if (view.startsWith("offer-")) {
      offer = offers[view.slice("offer-".length)]!;
      root.render(<OfferApp />);
      return;
    }
    root.render(<MaintenanceDialog profileId="demo" platform="darwin" onClose={() => undefined} onRemoveWorktrees={noRemove} />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
