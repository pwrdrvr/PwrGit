// @vitest-environment jsdom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const showErrorToastMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
vi.mock("../../lib/toast", () => ({ showErrorToast: showErrorToastMock }));
// A lightbox that opens fine and then throws on its next render — the shape
// of the 2026-10-05 report, where the window went blank once the pair loaded.
vi.mock("./ImageLightbox", () => ({
  ImageLightbox: function BrokenLightbox() {
    const [loaded, setLoaded] = useState(false);
    useEffect(() => setLoaded(true), []);
    if (loaded) throw new Error("planDiff: extent mismatch");
    return <div className="image-lightbox">opening…</div>;
  }
}));

import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";
import {
  installObjectUrlLedger,
  type ObjectUrlLedger
} from "../../test-support/object-urls";

const REVISIONS: ImageDiffRevisions = {
  worktreeId: "wt-1",
  before: { kind: "index" },
  after: { kind: "worktree" }
};

const PATCH = [
  "diff --git a/art/icon.png b/art/icon.png",
  "index 1111111..2222222 100644",
  "Binary files a/art/icon.png and b/art/icon.png differ",
  ""
].join("\n");

let container: HTMLDivElement;
let root: Root;
let urls: ObjectUrlLedger;

beforeEach(() => {
  dispatchMock.mockImplementation(async (name: string) =>
    name === "diff:image"
      ? ok({ kind: "image", mediaType: "image/png", bytes: new Uint8Array(2048) })
      : ok(null)
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  urls = installObjectUrlLedger();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  urls.restore();
  vi.restoreAllMocks();
});

describe("DiffViewer when the image lightbox throws", () => {
  it("closes the lightbox, keeps the diff, and says what happened", async () => {
    await act(async () => {
      root.render(<DiffViewer patch={PATCH} images={REVISIONS} />);
    });
    const frame = container.querySelector("button.diff-image__frame");
    expect(frame).not.toBeNull();

    await act(async () => {
      frame?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Not a blank window: the lightbox is gone and the row under it remains.
    expect(document.querySelector(".image-lightbox")).toBeNull();
    expect(container.querySelector(".diff-file")).not.toBeNull();
    expect(container.textContent).toContain("art/icon.png");

    expect(showErrorToastMock).toHaveBeenCalledTimes(1);
    expect(showErrorToastMock.mock.calls[0]![0]).toMatchObject({
      title: "Couldn’t show the image viewer",
      detail: "planDiff: extent mismatch",
      subject: { worktreeId: "wt-1" }
    });

    // And the next click opens it again rather than staying stuck.
    await act(async () => {
      container
        .querySelector("button.diff-image__frame")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(showErrorToastMock).toHaveBeenCalledTimes(2);
  });
});
