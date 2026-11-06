import { createRoot } from "react-dom/client";
import { ok } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { MaintenanceDialog } from "../../../src/renderer/src/features/sidebar/MaintenanceDialog";

const bridge = {
  profileId: "demo", platform: "darwin",
  appearance: { theme: "light", resolvedTheme: "light" },
  dispatch: async (name: string): Promise<unknown> => {
    if (name === "settings:read") return ok({ general: { branchCleanupPrProof: true, branchCleanupKeepDays: 7 } });
    if (name === "repo:list") return ok([{ id: "atlas", name: "atlas-client" }, { id: "beacon", name: "beacon-api" }]);
    return ok(null);
  },
  on: () => () => undefined,
  getAppMenuModel: async () => [], popupAppMenu: () => undefined,
  runWindowControl: async () => undefined, readWindowFrameState: async () => null,
  onWindowFrameState: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";
await Promise.all([
  '400 13px "Geist Sans"', '500 11px "Geist Sans"', '600 13px "Geist Sans"', '700 12px "Geist Sans"',
  '400 11px "Geist Mono"', '500 10px "Geist Mono"', '600 11px "Geist Mono"'
].map((font) => document.fonts.load(font)));
await document.fonts.ready;
// Snapshot before mounting: layout tests must not pass just because the
// dialog happened to finish loading its faces before an assertion ran.
(window as unknown as { __maintenanceFonts: { family: string; weight: string; status: string }[] }).__maintenanceFonts =
  [...document.fonts].map((face) => ({ family: face.family.replaceAll('"', ""), weight: face.weight, status: face.status }));
createRoot(document.getElementById("root")!).render(<MaintenanceDialog profileId="demo" platform="darwin"
  onClose={() => undefined} onRemoveWorktrees={async () => ({ removed: [], keptDirty: [], failed: [] })} />);
