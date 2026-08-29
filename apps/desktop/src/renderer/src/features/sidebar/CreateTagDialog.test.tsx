// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type ResolvedCommit, type TagSummary } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { CreateTagDialog } from "./CreateTagDialog";

const target = "466c894abcdef0123456789abcdef0123456789a";
const resolved: ResolvedCommit = {
  commitId: target,
  shortId: "466c894",
  subject: "Add repository tag refs",
  authorName: "Harold Hunt",
  committedAt: "2026-08-29T11:31:25Z",
  resolvedFrom: "main"
};
const created: TagSummary = {
  name: "v1.2.0",
  fullName: "refs/tags/v1.2.0",
  kind: "lightweight",
  objectId: target,
  objectType: "commit",
  targetId: target,
  targetType: "commit"
};

let container: HTMLDivElement;
let root: Root;
const onCreated = vi.fn();
const onClose = vi.fn();

/** The resolver is debounced; nothing lands until the timer runs. */
async function settleResolve(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(async () => undefined);
}

async function render(initialTarget?: string): Promise<void> {
  await act(async () => {
    root.render(
      <CreateTagDialog
        repoId="repo-1"
        repoName="PwrGit"
        {...(initialTarget === undefined ? {} : { initialTarget })}
        onCreated={onCreated}
        onClose={onClose}
      />
    );
  });
}

async function value(element: HTMLInputElement | HTMLTextAreaElement, next: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, next);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const createButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(".modal__create")!;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatchMock.mockImplementation(async (channel: string) =>
    channel === "tag:resolveCommit" ? ok(resolved) : ok(created)
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CreateTagDialog", () => {
  it("tags the resolved commit id, not the name that was typed", async () => {
    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[0]!, "v1.2.0");
    await value(fields[1]!, "main");
    await settleResolve();

    expect(dispatchMock).toHaveBeenCalledWith("tag:resolveCommit", {
      repoId: "repo-1",
      revision: "main"
    });
    // The whole point of resolving in front of the user: they see which commit
    // the name currently means before the tag is written there.
    expect(container.textContent).toContain("466c894");
    expect(container.textContent).toContain("Add repository tag refs");
    expect(container.textContent).toContain("main is here now");

    await act(async () => createButton().click());
    // `tag:create` still receives an explicit object id — the contract that
    // keeps review and execution talking about the same commit is intact.
    expect(dispatchMock).toHaveBeenCalledWith("tag:create", {
      repoId: "repo-1",
      name: "v1.2.0",
      targetCommit: target,
      kind: "lightweight"
    });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
  });

  it("seeds the target when opened from a commit", async () => {
    await render(target);
    await settleResolve();

    expect(container.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe(
      target
    );
    expect(dispatchMock).toHaveBeenCalledWith("tag:resolveCommit", {
      repoId: "repo-1",
      revision: target
    });
  });

  it("defaults to HEAD so the dialog opens on a usable target", async () => {
    await render();
    await settleResolve();

    expect(container.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe(
      "HEAD"
    );
    expect(dispatchMock).toHaveBeenCalledWith("tag:resolveCommit", {
      repoId: "repo-1",
      revision: "HEAD"
    });
  });

  it("blocks creation while the target does not resolve", async () => {
    dispatchMock.mockImplementation(async (channel: string) =>
      channel === "tag:resolveCommit"
        ? err({
            kind: "repo",
            code: "invalid_target_commit",
            message: "nope does not resolve to a commit"
          })
        : ok(created)
    );
    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[0]!, "v1.2.0");
    await value(fields[1]!, "nope");
    await settleResolve();

    expect(container.textContent).toContain("does not resolve to a commit");
    expect(createButton().disabled).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalledWith("tag:create", expect.anything());
  });

  it("requires and sends the annotated message separately", async () => {
    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[0]!, "v1.2.0");
    await value(fields[1]!, "main");
    await settleResolve();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "annotated";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(createButton().disabled).toBe(true);

    await value(
      container.querySelector<HTMLTextAreaElement>("textarea")!,
      "Release 1.2\n\nReviewed notes"
    );
    await act(async () => createButton().click());

    expect(dispatchMock).toHaveBeenCalledWith("tag:create", {
      repoId: "repo-1",
      name: "v1.2.0",
      targetCommit: target,
      kind: "annotated",
      message: "Release 1.2\n\nReviewed notes"
    });
  });

  it("discards a resolution that lands after the target changed", async () => {
    // The real race is a request that is ALREADY IN FLIGHT when the field
    // changes — not two edits inside one debounce window, which the timer
    // collapses on its own. Hold the first response open, let the debounce
    // fire, then edit and release it.
    const stale: ResolvedCommit = {
      ...resolved,
      commitId: "0".repeat(40),
      shortId: "0000000",
      subject: "the commit that was typed first",
      resolvedFrom: "old"
    };
    let releaseFirst: (() => void) | null = null;
    dispatchMock.mockImplementation(async (channel: string, req: unknown) => {
      if (channel !== "tag:resolveCommit") return ok(created);
      const { revision } = req as { revision: string };
      if (revision !== "old") return ok(resolved);
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
      return ok(stale);
    });

    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[0]!, "v1.2.0");
    await value(fields[1]!, "old");
    await settleResolve();
    expect(releaseFirst).not.toBeNull();

    // The field moves on while "old" is still outstanding.
    await value(fields[1]!, "main");
    await act(async () => {
      releaseFirst?.();
    });

    // The superseded response must not paint, and — the part that actually
    // bites — must not re-enable Create while carrying the old commit.
    expect(container.textContent).not.toContain("0000000");
    expect(container.textContent).not.toContain("the commit that was typed first");
    expect(createButton().disabled).toBe(true);

    // The newest one still lands.
    await settleResolve();
    expect(container.textContent).toContain("466c894");
    expect(createButton().disabled).toBe(false);
    await act(async () => createButton().click());
    expect(dispatchMock).toHaveBeenCalledWith("tag:create", {
      repoId: "repo-1",
      name: "v1.2.0",
      targetCommit: target,
      kind: "lightweight"
    });
  });

  it("stops resolving once the dialog is dismissed", async () => {
    await render();
    const fields = container.querySelectorAll<HTMLInputElement>("input");
    await value(fields[1]!, "main");
    await act(async () => root.unmount());
    // Whatever was outstanding must not write to an unmounted tree.
    await settleResolve();
  });
});
