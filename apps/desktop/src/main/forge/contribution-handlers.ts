import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { ContributionService } from "./contribution-service";

export function registerContributionHandlers(bus: CommandBus, service: ContributionService): void {
  // Only generic/sanitized errors cross IPC; do not log private forge payloads.
  const failure = (cause: unknown) => err({ kind: "remote" as const, code: "contribution_read_failed", message: cause instanceof Error ? cause.message : "Contribution analytics could not be read." });
  bus.register("contribution:verify", async req => {
    try { return ok(await service.verify(req)); } catch (cause) { return failure(cause); }
  });
  bus.register("contribution:read", req => {
    try { return ok(service.read(req)); } catch (cause) { return failure(cause); }
  });
  bus.register("contribution:sync", async req => {
    try { return ok(await service.start(req, req.refresh)); } catch (cause) { return failure(cause); }
  });
  bus.register("contribution:cancel", async req => {
    try { await service.cancel(req); return ok(null); } catch (cause) { return failure(cause); }
  });
  bus.register("contribution:clear", async req => {
    try { await service.clear(req); return ok(null); } catch (cause) { return failure(cause); }
  });
}
