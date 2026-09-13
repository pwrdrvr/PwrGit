import { ok } from "@pwrgit/shared";
import type { CommandBus, CommandContext } from "../command-bus";
import type { SshHostTrustService } from "./ssh-host-trust";

function owner(ctx: CommandContext): number {
  if (ctx.webContentsId === undefined || ctx.isMainFrame !== true) {
    throw new Error("SSH trust approval is available only in the desktop window.");
  }
  return ctx.webContentsId;
}
export function registerSshHostTrustHandlers(bus: CommandBus, service: SshHostTrustService): void {
  bus.register("forge:inspectSshHost", async (req, ctx) =>
    ok(await service.inspect(req.kind, req.hostname, owner(ctx)))
  );
  bus.register("forge:trustSshHost", async (req, ctx) => {
    await service.trust(req.proposalId, owner(ctx));
    return ok(null);
  });
}
