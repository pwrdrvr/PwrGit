// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: subscribeMock
}));

import { ToastHost } from "./ToastHost";
import {
  dismissToast,
  showErrorToast,
  showInfoToast,
  subscribeToasts,
  type Toast
} from "../../lib/toast";

let container: HTMLDivElement;
let root: Root;

function eyebrows(): string[] {
  return [...container.querySelectorAll(".app-toast__eyebrow")].map((node) =>
    node.className.includes("--info") ? `info:${node.textContent}` : `error:${node.textContent}`
  );
}

beforeEach(async () => {
  dispatchMock.mockResolvedValue(ok({ status: "idle" }));
  subscribeMock.mockReturnValue(() => undefined);
  let current: Toast[] = [];
  const unsubscribe = subscribeToasts((next) => {
    current = next;
  });
  for (const toast of [...current]) dismissToast(toast.id);
  unsubscribe();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastHost />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ToastHost", () => {
  it("keeps a confirmation out of the danger color", async () => {
    await act(async () => {
      showErrorToast({ title: "Push failed", message: "remote rejected" });
      showInfoToast({ title: "Tag created", message: "v1.2.3" });
    });

    expect(eyebrows()).toEqual(["error:Push failed", "info:Tag created"]);
  });

  it("replaces a keyed toast in place instead of stacking it", async () => {
    await act(async () => {
      showInfoToast({ key: "check", title: "Checking", message: "…" });
      showErrorToast({ title: "Push failed", message: "remote rejected" });
      showInfoToast({ key: "check", title: "Up to date", message: "v1.0.0" });
    });

    expect(eyebrows()).toEqual(["info:Up to date", "error:Push failed"]);
  });

  it("dismisses one toast without disturbing the others", async () => {
    await act(async () => {
      showInfoToast({ title: "Tag created", message: "v1.2.3" });
      showErrorToast({ title: "Push failed", message: "remote rejected" });
    });

    const dismiss = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Dismiss"
    );
    await act(async () => dismiss?.click());

    expect(eyebrows()).toEqual(["error:Push failed"]);
  });
});
