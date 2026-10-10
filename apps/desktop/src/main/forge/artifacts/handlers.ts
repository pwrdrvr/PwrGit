import { err, parseArtifactsRemote } from "@pwrgit/shared";
import type { CommandBus } from "../../command-bus";
import type { ArtifactsCredentials } from "./credentials";

export function registerArtifactsCredentialHandlers(
  bus: CommandBus,
  store: ArtifactsCredentials,
  registerHost: (hostname: string) => void,
  changed: () => Promise<unknown>
): void {
  bus.register("artifacts:credentials", () => store.status());
  bus.register("artifacts:saveCredential", async (req, context) => {
    if (context.isMainFrame !== true || context.webContentsId === undefined) return err({ kind: "validation", code: "local_window_required", message: "Manage Artifacts credentials in PwrGit Settings." });
    const result = store.save(req?.remote, req?.token);
    if (result.ok) {
      registerHost(parseArtifactsRemote(req.remote)!.hostname);
      await changed();
    }
    return result;
  });
  bus.register("artifacts:removeCredential", async (req, context) => {
    if (context.isMainFrame !== true || context.webContentsId === undefined) return err({ kind: "validation", code: "local_window_required", message: "Manage Artifacts credentials in PwrGit Settings." });
    const result = store.remove(req?.remote);
    if (result.ok) await changed();
    return result;
  });
}
