import { expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { ok } from "@pwrgit/shared";
import { execGit } from "./dugite";
import { SshHostTrustService } from "./ssh-host-trust";

vi.mock("./dugite", () => ({ execGit: vi.fn() }));

it("checks SSH overrides with the application's Git runtime before inspecting a host", async () => {
  vi.mocked(execGit).mockResolvedValue(ok({ exitCode: 0, stdout: "custom-ssh", stderr: "" }));
  const service = new SshHostTrustService({ allowed: () => true, env: {} });
  await expect(service.inspect("github", "github.com", 1)).rejects.toThrow("Custom Git SSH configuration");
  expect(execGit).toHaveBeenCalledWith(["config", "--get", "core.sshCommand"], homedir(), {
    signal: expect.any(AbortSignal)
  });
});
