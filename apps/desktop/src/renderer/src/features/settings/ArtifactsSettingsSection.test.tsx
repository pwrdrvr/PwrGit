// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgeCapabilities, ok, type ArtifactsCredentialStatus, type ForgeStatus } from "@pwrgit/shared";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => mocks);
import { ArtifactsSettingsSection } from "./ArtifactsSettingsSection";
import { __resetCollapsedPanesForTests } from "./SettingsLayout";

let container: HTMLDivElement;
let root: Root;
const remote = "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/default/demo.git";
const token = `art_v1_${"a".repeat(40)}?expires=1900000000`;
beforeEach(() => {
  __resetCollapsedPanesForTests(); vi.clearAllMocks();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async (forgeStatus?: ForgeStatus) => { await act(async () => root.render(<ArtifactsSettingsSection kind="artifacts" blocked={false} forgeStatus={forgeStatus} />)); };
function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
it("saves a password input, clears it, and reports saved metadata without claiming a live connection", async () => {
  mocks.dispatch.mockImplementation(async (channel: string) => ok({ secureStorageAvailable: true, credentials: channel === "artifacts:saveCredential" ? [{ remote, expiresAt: 1_900_000_000_000, expired: false }] : [] }));
  await render();
  expect(container.textContent).toContain("Add token");
  expect(container.querySelector('[aria-label="Artifacts repository token"]')?.getAttribute("type")).toBe("password");
  await act(async () => { input("Artifacts repository remote", remote); input("Artifacts repository token", token); });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mocks.dispatch).toHaveBeenCalledWith("artifacts:saveCredential", { remote, token });
  expect(container.querySelector<HTMLInputElement>('[aria-label="Artifacts repository token"]')?.value).toBe("");
  expect(container.textContent).toContain("Tokens saved"); expect(container.textContent).not.toContain("Connected");
  expect(container.textContent).toContain("not verified against Cloudflare");
  expect(container.textContent).not.toContain(token);
  const guide = [...container.querySelectorAll("button")].find((button) => button.textContent === "Token guide");
  await act(async () => guide!.click());
  expect(mocks.dispatch).toHaveBeenCalledWith("shell:openExternal", { url: "https://developers.cloudflare.com/artifacts/guides/authentication/" });
});
it("refuses save when OS encryption is unavailable", async () => {
  mocks.dispatch.mockResolvedValue(ok({ secureStorageAvailable: false, credentials: [] }));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Plaintext storage is refused");
  await act(async () => { input("Artifacts repository remote", remote); input("Artifacts repository token", token); });
  expect(container.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
});
it("reports expired tokens and handles a rejected IPC read without echoing the error", async () => {
  mocks.dispatch.mockResolvedValue(ok({ secureStorageAvailable: true, credentials: [{ remote, expiresAt: 1, expired: true }] }));
  await render(); expect(container.textContent).toContain("Expired"); expect(container.textContent).toContain("Add token");
  act(() => root.unmount()); root = createRoot(container);
  mocks.dispatch.mockRejectedValue(new Error(token)); await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not read credential metadata");
  expect(container.textContent).not.toContain(token);
});
it("refreshes expiry metadata when a recheck replaces the forge status", async () => {
  const connected: ForgeStatus = { kind: "artifacts", cli: "", installed: true, loggedIn: true, capabilities: forgeCapabilities("artifacts"), hosts: [] };
  mocks.dispatch.mockResolvedValue(ok({ secureStorageAvailable: true, credentials: [{ remote, expiresAt: 1_900_000_000_000, expired: false }] }));
  await render(connected);
  expect(container.textContent).toContain("Tokens saved");
  expect(container.textContent).toContain("Expires");
  mocks.dispatch.mockResolvedValue(ok({ secureStorageAvailable: true, credentials: [{ remote, expiresAt: 1_900_000_000_000, expired: true }] }));
  await render({ ...connected, loggedIn: false });
  expect(container.textContent).toContain("Add token");
  expect(container.textContent).toContain("Expired");
  expect(container.textContent).not.toContain("Tokens saved");
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
});
it("ignores a stale metadata read after a newer status refresh", async () => {
  let resolveOld!: (value: ReturnType<typeof ok<ArtifactsCredentialStatus>>) => void;
  const oldRead = new Promise<ReturnType<typeof ok<ArtifactsCredentialStatus>>>((resolve) => { resolveOld = resolve; });
  mocks.dispatch.mockReturnValueOnce(oldRead).mockResolvedValue(ok({ secureStorageAvailable: true, credentials: [{ remote, expiresAt: 1, expired: true }] }));
  await render();
  await render({ kind: "artifacts", cli: "", installed: true, loggedIn: false, capabilities: forgeCapabilities("artifacts"), hosts: [] });
  await act(async () => resolveOld(ok({ secureStorageAvailable: true, credentials: [{ remote, expiresAt: 1_900_000_000_000, expired: false }] })));
  expect(container.textContent).toContain("Expired");
  expect(container.textContent).toContain("Add token");
  expect(container.textContent).not.toContain("Tokens saved");
});
