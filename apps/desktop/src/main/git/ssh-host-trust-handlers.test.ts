import { expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { registerSshHostTrustHandlers } from "./ssh-host-trust-handlers";
import type { SshHostTrustService } from "./ssh-host-trust";
it("restricts inspection and approval to desktop main-frame senders", async () => {
  const inspect = vi.fn(async () => ({}));
  const trust = vi.fn(async () => undefined);
  const bus = new CommandBus();
  registerSshHostTrustHandlers(bus, { inspect, trust } as unknown as SshHostTrustService);
  const req = { kind: "gitcafe" as const, hostname: "git.cafe" };
  expect((await bus.dispatch("forge:inspectSshHost", req)).ok).toBe(false);
  expect((await bus.dispatch("forge:inspectSshHost", req, { webContentsId: 7, isMainFrame: false })).ok).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
  expect((await bus.dispatch("forge:inspectSshHost", req, { webContentsId: 7, isMainFrame: true })).ok).toBe(true);
  expect(inspect).toHaveBeenCalledWith("gitcafe", "git.cafe", 7);
  expect((await bus.dispatch("forge:trustSshHost", { proposalId: "opaque" }, { webContentsId: 7, isMainFrame: true })).ok).toBe(true);
  expect(trust).toHaveBeenCalledWith("opaque", 7);
});
