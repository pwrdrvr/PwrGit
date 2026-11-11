// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type PrSummary } from "@pwrgit/shared";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch }));

import { PrStatusCard } from "./PrStatusCard";

const ready: PrSummary = {
  number: 41,
  url: "https://github.com/o/r/pull/41",
  title: "t",
  state: "open",
  isDraft: false,
  checkState: "passing",
  mergeState: "mergeable",
  forge: "github",
  repoPath: "o/r",
  headOid: "a".repeat(40),
  mergeQueue: { required: true, blocked: false }
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  dispatch.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (pr: PrSummary, repoId?: string) =>
  act(() => root.render(<PrStatusCard pr={pr} {...(repoId === undefined ? {} : { repoId })} />));
const button = () => container.querySelector<HTMLButtonElement>(".pr-status-card__queue-action");

describe("Add to merge queue", () => {
  it("is offered for a PR ready to queue, in the forge's words", () => {
    render(ready, "repo-1");
    expect(button()?.textContent).toBe("Add to merge queue");
    expect(container.textContent).toContain("ready to queue");
    render({ ...ready, forge: "gitlab" }, "repo-1");
    expect(button()?.textContent).toBe("Add to merge train");
  });

  it("is not offered where it cannot act or the PR is not ready", () => {
    render(ready); // no checkout to act from
    expect(button()).toBeNull();
    render({ ...ready, mergeQueue: { required: false } }, "repo-1"); // merges directly
    expect(button()).toBeNull();
    render({ ...ready, checkState: "failing" }, "repo-1");
    expect(button()).toBeNull();
    render({ ...ready, mergeQueue: { required: true, entry: { state: "queued", position: 2 } } }, "repo-1");
    expect(button()).toBeNull();
    expect(container.textContent).toContain("queued #2");
    render({ ...ready, forge: "gitcafe" }, "repo-1"); // no enqueue in that integration
    expect(button()).toBeNull();
  });

  it("asks main to enqueue, pinned to the head the user saw, and shows a refusal", async () => {
    dispatch.mockResolvedValueOnce({ ok: false, error: { kind: "remote", code: "head_moved", message: "New commits." } });
    render(ready, "repo-1");
    await act(async () => { button()?.click(); });
    expect(dispatch).toHaveBeenCalledWith("pr:enqueue", {
      repoId: "repo-1", number: 41, repoPath: "o/r", headOid: "a".repeat(40)
    });
    expect(container.querySelector("[role='alert']")?.textContent).toBe("New commits.");
    dispatch.mockResolvedValueOnce(ok({ position: 1 }));
    await act(async () => { button()?.click(); });
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("names the method only when the queue imposes one", () => {
    render({ ...ready, mergeQueue: { required: true, blocked: false, method: "squash" } }, "repo-1");
    expect(container.textContent).toContain("The queue squashes");
    expect(container.querySelector("select, [role='radiogroup']")).toBeNull();
  });
});
