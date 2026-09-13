// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ok, err, type SshHostTrustProposal } from "@pwrgit/shared";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => mocks);
import { SshHostTrustPanel, sshTrustTone } from "./SshHostTrustPanel";
const writeText = vi.fn(async () => {});
Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let proposal: SshHostTrustProposal;
const retry = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  proposal = { id: "server-owned-token", hostname: "git.cafe", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:contrived", verification: "unpublished", sourceUrl: null, canTrust: true, message: "Verify independently." };
  mocks.dispatch.mockImplementation(async (name) => name === "forge:inspectSshHost" ? ok(proposal) : ok(null));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
async function inspect() {
  await act(async () => root.render(<SshHostTrustPanel kind="gitcafe" hostname="git.cafe" onTrusted={retry} />));
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await act(async () => button("Inspect host key").click());
}
it("requires independent-verification acknowledgement and explicit approval before writing", async () => {
  await inspect();
  expect(container.textContent).toContain("git.cafe:22");
  expect(container.textContent).toContain("SHA256:contrived");
  expect(button("Trust and retry").disabled).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>("input")!.click());
  expect(retry).not.toHaveBeenCalled();
  await act(async () => button("Trust and retry").click());
  expect(mocks.dispatch).toHaveBeenLastCalledWith("forge:trustSshHost", { proposalId: "server-owned-token" });
  expect(retry).toHaveBeenCalledOnce();
});
it("shows a published match but still requires a trust click", async () => {
  proposal.verification = "published-match"; proposal.sourceUrl = "https://api.github.com/meta";
  await inspect();
  expect(container.textContent).toContain(proposal.sourceUrl);
  expect(button("Trust and retry").disabled).toBe(false);
  expect(retry).not.toHaveBeenCalled();
  await act(async () => button("Cancel").click());
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
});
it.each(["mismatch", "existing-key"] as const)("does not offer trust for %s", async (state) => {
  proposal.verification = state; proposal.canTrust = false;
  await inspect();
  expect(button("Trust and retry")).toBeUndefined();
});
it("reports the verdict upward so the card can retone, and withdraws it on cancel", async () => {
  const onVerification = vi.fn();
  proposal.verification = "published-match";
  await act(async () => root.render(<SshHostTrustPanel kind="github" hostname="github.com" onTrusted={retry} onVerification={onVerification} />));
  await act(async () => button("Inspect host key").click());
  expect(onVerification).toHaveBeenLastCalledWith("published-match");
  await act(async () => button("Cancel").click());
  expect(onVerification).toHaveBeenLastCalledWith(null);
});

it("paints the good answer, the bad one, and the undecided ones apart", () => {
  expect(sshTrustTone("published-match")).toBe("ok");
  expect(sshTrustTone("mismatch")).toBe("danger");
  for (const state of ["unpublished", "lookup-failed", "existing-key"] as const) {
    expect(sshTrustTone(state)).toBe("warn");
  }
});

it("offers the fingerprint for copying — it is the value being compared", async () => {
  await inspect();
  const fingerprint = container.querySelector(".ssh-trust__fingerprint");
  expect(fingerprint?.textContent).toBe("SHA256:contrived");
  await act(async () => button("Copy fingerprint").click());
  expect(writeText).toHaveBeenCalledWith("SHA256:contrived");
});

// `disabled` blurs the control in Chromium, so a keyboard activation would
// drop focus to <body> for the length of the lookup (SC 2.4.3).
it("marks an in-flight control aria-disabled rather than disabled", async () => {
  let release: (value: unknown) => void = () => {};
  mocks.dispatch.mockImplementation(() => new Promise((resolveDispatch) => { release = resolveDispatch; }));
  await act(async () => root.render(<SshHostTrustPanel kind="gitcafe" hostname="git.cafe" onTrusted={retry} />));
  await act(async () => button("Inspect host key").click());
  const busy = button("Checking host key…");
  expect(busy.disabled).toBe(false);
  expect(busy.getAttribute("aria-disabled")).toBe("true");
  busy.click();
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  await act(async () => { release(ok(proposal)); });
});

it("never retries the clone when saving the key fails", async () => {
  proposal.verification = "published-match";
  await inspect();
  mocks.dispatch.mockResolvedValue(err({ kind: "validation", code: "expired", message: "Inspect the host again." }));
  await act(async () => button("Trust and retry").click());
  expect(retry).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Inspect the host again.");
  expect(button("Inspect host key")).toBeDefined();
});
