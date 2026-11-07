// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../lib/pwrgit", () => mocks);
import { AgentAccessSection, connectionRecipes } from "./AgentAccessSection";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReturnValue(() => undefined);
  mocks.dispatch.mockResolvedValue(ok({ enabled: false, listening: false, mcpUrl: "unix:///tmp/pg/m.sock#/mcp", executable: "/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp", platform: "darwin" }));
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
it("offers the native relay and direct IPC bootstrap, without TCP or OAuth recipes", async () => {
  mocks.dispatch.mockResolvedValue(ok({ enabled: true, listening: true, mcpUrl: "unix:///tmp/pg/m.sock#/mcp", executable: "/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp", platform: "darwin" }));
  await render();
  for (const recipe of connectionRecipes("/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp", "darwin")) expect(container.textContent).toContain(recipe.command);
  expect(container.textContent).not.toContain("127.0.0.1");
  expect(container.textContent).not.toContain("mcp login");
});
it("keeps the HTTP secret out of copyable configuration and rotates its input reference", async () => {
  mocks.dispatch.mockImplementation((command: string) => Promise.resolve(ok(command === "agentAccess:bootstrapHttp" ? { token: "fixture-secret", expiresAt: "2026-11-07T17:02:00Z" } : { enabled: true, listening: true, mcpUrl: "unix:///tmp/pg/m.sock#/mcp", executable: "/fixture/pwrgit-mcp", platform: "darwin" })));
  await render();
  const approve = [...container.querySelectorAll("button")].find(button => button.textContent === "Approve a direct HTTP Session")!;
  await act(async () => approve.click());
  const first = [...container.querySelectorAll("pre")].find(pre => pre.textContent?.includes('"inputs"'))!.textContent!;
  expect(first).not.toContain("fixture-secret");
  expect(first).toContain('"password": true');
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("fixture-secret");
  await act(async () => approve.click());
  const second = [...container.querySelectorAll("pre")].find(pre => pre.textContent?.includes('"inputs"'))!.textContent!;
  expect(second).not.toBe(first);
});

it("shows bind failures without offering unusable commands", async () => {
  mocks.dispatch.mockResolvedValue(ok({ enabled: true, listening: false, error: "Port is in use" }));
  await render();
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Port is in use");
  expect(container.textContent).not.toContain("codex mcp add");
});
