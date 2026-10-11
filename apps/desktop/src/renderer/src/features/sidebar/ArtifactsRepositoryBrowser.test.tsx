// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { err, forgeCapabilities, ok, type CloneRepository } from "@pwrgit/shared";
const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
import { ArtifactsRepositoryBrowser } from "./ArtifactsRepositoryBrowser";

it("browses only on request, pins account/namespace, verifies a chosen remote and creates only on explicit submission", async () => {
  const hostname = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
  const repo: CloneRepository = { name: "demo", owner: "default", nameWithOwner: "default/demo", host: "artifacts", hostname, visibility: "unknown", httpsUrl: `https://${hostname}/git/default/demo.git`, sshUrl: "", localPaths: [] };
  const choose = vi.fn();
  dispatchMock.mockImplementation(async (channel: string) => {
    if (channel === "artifacts:accounts") return ok({ installed: true, loggedIn: true, accounts: [{ hostname, name: "Fixture account" }, { hostname: "f".repeat(32) + ".artifacts.cloudflare.net", name: "Disabled account" }] });
    if (channel === "artifacts:namespaces") return ok(["default"]);
    if (channel === "artifacts:repos") return ok([repo]);
    if (channel === "artifacts:repo" || channel === "artifacts:createRepo") return ok(repo);
    return err({ kind: "remote", code: "unexpected", message: "Unexpected command" });
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const select = async (label: string, value: string) => {
    await act(async () => {
      const element = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
      element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<ArtifactsRepositoryBrowser disabled={false} status={{ kind: "artifacts", cli: "wrangler", installed: true, loggedIn: true, capabilities: forgeCapabilities("artifacts"), hosts: [{ host: "f".repeat(32) + ".artifacts.cloudflare.net", enabled: false, loggedIn: false }] }} onChoose={choose} />));
    expect(dispatchMock).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).not.toContain("Disabled account");
    await select("Cloudflare account", hostname);
    expect(dispatchMock).toHaveBeenLastCalledWith("artifacts:namespaces", { hostname });
    await select("Artifacts namespace", "default");
    expect(dispatchMock).toHaveBeenLastCalledWith("artifacts:repos", { hostname, namespace: "default" });
    expect(dispatchMock.mock.calls.some(([channel]) => channel === "artifacts:createRepo")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(dispatchMock).toHaveBeenLastCalledWith("artifacts:repo", { remote: repo.httpsUrl });
    expect(choose).toHaveBeenCalledWith(repo);
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[aria-label="New Artifacts repository name"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "demo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Create repository")!.click());
    expect(dispatchMock).toHaveBeenLastCalledWith("artifacts:createRepo", { hostname, namespace: "default", name: "demo" });
    expect(choose).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); }
});

it("shows missing-Wrangler guidance and does not offer repository creation without a connected account", async () => {
  dispatchMock.mockResolvedValue(ok({ installed: false, loggedIn: false, accounts: [] }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ArtifactsRepositoryBrowser disabled={false} status={undefined} onChoose={vi.fn()} />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("npm install -g wrangler");
    expect(container.textContent).not.toContain("Create repository");
  } finally { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); }
});
