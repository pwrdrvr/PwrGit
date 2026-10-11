import { expect, it, vi } from "vitest";
import { CommandBus } from "../../command-bus";
import { registerArtifactsAccountHandlers } from "./handlers";
import { ArtifactsWrangler } from "./wrangler";

it("guards disabled hosts and repository creation before invoking Wrangler, and redacts errors", async () => {
  const host = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
  const run = vi.fn(async () => { throw new Error('failure {"apiToken":"secret-control-token"}'); });
  const client = new ArtifactsWrangler(run);
  let enabled = false;
  const bus = new CommandBus(); const refresh = vi.fn(async () => undefined);
  registerArtifactsAccountHandlers(bus, client, () => enabled, refresh);
  expect(await bus.dispatch("artifacts:namespaces", { hostname: host })).toMatchObject({ ok: false, error: { code: "forge_host_off" } });
  expect(await bus.dispatch("artifacts:repos", { hostname: host, namespace: "default" })).toMatchObject({ ok: false, error: { code: "forge_host_off" } });
  expect(await bus.dispatch("artifacts:repo", { remote: `https://${host}/git/default/demo.git` })).toMatchObject({ ok: false, error: { code: "forge_host_off" } });
  enabled = true;
  for (const context of [{}, { webContentsId: 1, isMainFrame: false }]) {
    expect(await bus.dispatch("artifacts:createRepo", { hostname: host, namespace: "default", name: "demo" }, context)).toMatchObject({ ok: false, error: { code: "local_window_required" } });
  }
  expect(run).not.toHaveBeenCalled();
  const failure = await bus.dispatch("artifacts:createRepo", { hostname: host, namespace: "default", name: "demo" }, { webContentsId: 1, isMainFrame: true });
  expect(failure.ok).toBe(false); expect(JSON.stringify(failure)).not.toContain("secret-control-token");
  await bus.dispatch("artifacts:accounts", { force: true });
  expect(refresh).toHaveBeenCalledOnce();
});
