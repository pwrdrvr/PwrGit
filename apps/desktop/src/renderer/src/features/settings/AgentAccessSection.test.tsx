// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => mocks);
import { AgentAccessSection, CONNECT_RECIPES } from "./AgentAccessSection";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReturnValue(() => undefined);
  mocks.dispatch.mockResolvedValue(ok({ enabled: false, listening: false, mcpUrl: "http://127.0.0.1:51731/mcp" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = () => act(async () => { root.render(<AgentAccessSection />); });
it("shows the opt-in toggle and hides commands until listening", async () => {
  await render();
  expect(container.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).not.toContain("codex mcp add");
  await act(async () => { (container.querySelector("[role=switch]") as HTMLElement).click(); });
  expect(mocks.dispatch).toHaveBeenCalledWith("agentAccess:setEnabled", { enabled: true });
});
it("prints the same OAuth recipes as PwrSnap with PwrGit's name and port", async () => {
  mocks.dispatch.mockResolvedValue(ok({ enabled: true, listening: true, mcpUrl: "http://127.0.0.1:51731/mcp" }));
  await render();
  expect(CONNECT_RECIPES).toEqual([
    { name: "Claude Code", command: "claude mcp add --scope user --transport http pwrgit http://127.0.0.1:51731/mcp\nclaude mcp login pwrgit" },
    { name: "Codex CLI", command: "codex mcp add pwrgit --url http://127.0.0.1:51731/mcp --oauth-client-registration dcr" }
  ]);
  for (const recipe of CONNECT_RECIPES) expect(container.textContent).toContain(recipe.command);
  expect(container.textContent).not.toContain("pair");
});
it("shows bind failures without offering unusable commands", async () => {
  mocks.dispatch.mockResolvedValue(ok({ enabled: true, listening: false, error: "Port is in use" }));
  await render();
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Port is in use");
  expect(container.textContent).not.toContain("codex mcp add");
});
