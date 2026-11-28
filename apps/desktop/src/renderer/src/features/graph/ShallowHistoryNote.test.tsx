// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type ShallowHistory } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock, subscribe: () => () => undefined }));
vi.mock("../../lib/toast", () => ({ showInfoToast: toasts.info, showErrorToast: toasts.error }));
import { ShallowHistoryNote, shallowHistorySentence } from "./ShallowHistoryNote";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

const shallow: ShallowHistory = { boundaries: ["a".repeat(40)], remote: "origin", fetchesOnly: null };

async function draw(value: ShallowHistory): Promise<void> {
  await act(async () =>
    root.render(<ShallowHistoryNote repoId="r1" repoName="acme" worktreeId="w1" shallow={value} />)
  );
}
const button = (label: string): HTMLButtonElement =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label))!;

describe("ShallowHistoryNote", () => {
  it("fetches 100 older commits from the named remote, disabling both buttons meanwhile", async () => {
    let finish: (value: unknown) => void = () => undefined;
    dispatchMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await draw(shallow);
    expect(container.textContent).toContain("from origin");
    await act(async () => button("Fetch 100 older commits").click());
    expect(dispatchMock).toHaveBeenCalledWith("remote:deepenHistory", {
      repoId: "r1",
      worktreeId: "w1",
      remote: "origin",
      mode: { kind: "deepen", commits: 100 }
    });
    expect([...container.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    await act(async () => finish(ok({ remote: "origin", shallow: true, fetched: true })));
    expect(toasts.info).toHaveBeenCalledWith(expect.objectContaining({
      title: "Fetched older history",
      message: expect.stringContaining("still has limited history")
    }));
    expect(button("Fetch 100 older commits").disabled).toBe(false);
  });

  it("fetches full history only when asked, and says when it is complete", async () => {
    dispatchMock.mockResolvedValue(ok({ remote: "origin", shallow: false, fetched: true }));
    await draw(shallow);
    await act(async () => button("Fetch full history").click());
    expect(dispatchMock).toHaveBeenCalledWith("remote:deepenHistory", expect.objectContaining({ mode: { kind: "unshallow" } }));
    expect(toasts.info).toHaveBeenCalledWith(expect.objectContaining({ message: "acme now has its full history." }));
  });

  it("reports a server refusal as an error and a stop as a stop", async () => {
    dispatchMock.mockResolvedValueOnce(err({ kind: "remote", code: "shallow_unsupported", message: "origin can't serve…" }));
    await draw(shallow);
    await act(async () => button("Fetch full history").click());
    expect(toasts.error).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn’t fetch older history" }));

    dispatchMock.mockResolvedValueOnce(err({ kind: "git", code: "aborted", message: "Stopped at your request." }));
    await act(async () => button("Fetch 100 older commits").click());
    expect(toasts.info).toHaveBeenCalledWith(expect.objectContaining({ title: "Stopped" }));
  });

  it("offers no fetch without a remote, and never fetches on its own", async () => {
    await draw({ ...shallow, remote: null });
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("no remote to fetch them from");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("says when only some branches are fetched, instead of implying the rest exist", () => {
    expect(shallowHistorySentence({ ...shallow, fetchesOnly: ["main"] })).toContain(
      "fetches only main from origin, so other branches aren’t in PwrGit"
    );
    expect(shallowHistorySentence({ ...shallow, boundaries: [] })).toContain("older than the ones drawn here");
  });
});
