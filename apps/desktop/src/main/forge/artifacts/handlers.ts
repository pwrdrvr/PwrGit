import { err, ok, parseArtifactsRemote, type Result } from "@pwrgit/shared";
import type { CommandBus } from "../../command-bus";
import type { ArtifactsCredentials } from "./credentials";
import { wranglerClient, type ArtifactsWrangler } from "./wrangler";

export function registerArtifactsAccountHandlers(
  bus: CommandBus, client: ArtifactsWrangler,
  enabled: (hostname: string) => boolean,
  refresh: () => Promise<unknown>
): void {
  const run = async <T>(hostname: string, action: () => Promise<T>): Promise<Result<T>> => {
    if (!enabled(hostname)) return err({ kind: "remote", code: "forge_host_off", message: "Enable this Cloudflare account in Settings → Forges before using it." });
    try { return ok(await action()); }
    catch (cause) { return err({ kind: "remote", code: "artifacts_command_failed", message: wranglerClient.errorMessage(cause) }); }
  };
  bus.register("artifacts:accounts", async (req) => {
    if (req?.force) await refresh();
    return ok(await client.accounts());
  });
  bus.register("artifacts:namespaces", (req) => run(req.hostname, () => client.namespaces(req.hostname)));
  bus.register("artifacts:repos", (req) => run(req.hostname, () => client.repositories(req.hostname, req.namespace)));
  bus.register("artifacts:repo", (req) => {
    const remote = parseArtifactsRemote(req.remote);
    if (remote === null) return err({ kind: "validation", code: "invalid_artifacts_remote", message: "Choose an exact Artifacts HTTPS remote." });
    return run(remote.hostname, () => client.repositoryAt(remote.remote));
  });
  bus.register("artifacts:createRepo", (req, context) => {
    if (context.isMainFrame !== true || context.webContentsId === undefined) return err({ kind: "validation", code: "local_window_required", message: "Create Artifacts repositories in PwrGit's Clone dialog." });
    return run(req.hostname, () => client.createRepository(req.hostname, req.namespace, req.name));
  });
}

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
