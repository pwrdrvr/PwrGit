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
await document.fonts.load('400 12px "Geist"');
await document.fonts.ready;
createRoot(document.getElementById("root")!).render(<MaintenanceDialog profileId="demo" platform="darwin"
  onClose={() => undefined} onRemoveWorktrees={async () => ({ removed: [], keptDirty: [], failed: [] })} />);
