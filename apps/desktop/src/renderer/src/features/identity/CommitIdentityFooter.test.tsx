// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type CommitIdentityInspection } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), copyText: vi.fn(async () => undefined) }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../../lib/copyText", () => ({ copyText: mocks.copyText }));
import { CommitIdentityFooter } from "./CommitIdentityFooter";
import { KIT, inspection, recorded } from "./identity-test-fixtures";

let root: Root;
let container: HTMLDivElement;

async function render(
  value: CommitIdentityInspection | null,
  amendHover = false
): Promise<void> {
  await act(async () => {
    root.render(
      <CommitIdentityFooter inspection={value} fallbackEmail="rowan@vale.example" amendHover={amendHover} />
    );
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue(ok(null));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CommitIdentityFooter", () => {
  it("keeps the old line, inert, until Git has answered", async () => {
    await render(null);
    const line = button("as rowan@vale.example");
    expect(line.disabled).toBe(true);
  });

  it("opens the details: what PwrGit records, Git outside it, and recent commits", async () => {
    await render(
      inspection({
        recent: [recorded({ author: { name: "Rowan Vale", email: "4242+rowanv@users.noreply.github.com" } })]
      })
    );
    await act(async () => button("as Rowan Vale <rowan@vale.example>").click());
    const popover = container.querySelector("[role='dialog']");
    expect(popover?.textContent).toContain("PwrGit will record");
    expect(popover?.textContent).toContain("From your Personal profile");
    expect(popover?.textContent).toContain("Terminal and agent commits here fail with “Author identity unknown”");
    expect(popover?.textContent).toContain("GitHub noreply");

    await act(async () => button("Set up Git identity…").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("settings:open", { page: "profiles", sub: "git-identity" });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("previews the author Amend keeps while Amend is hovered", async () => {
    await render(inspection({ recent: [recorded({ author: KIT })] }), true);
    expect(container.textContent).toContain("Amend keeps author Kit Moreau <kit@moreau.example>");
    expect(container.textContent).toContain("committer Rowan Vale <rowan@vale.example>");
  });

  it("replaces the line with the fix when Git would refuse", async () => {
    await render(
      inspection({ pwrgit: { ok: false, problem: "no_name", message: "empty ident name not allowed" } })
    );
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Git has no name to record for this commit.");
    await act(async () => button("Add an author name to Personal…").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("settings:open", { page: "profiles", sub: "list" });
  });
});
