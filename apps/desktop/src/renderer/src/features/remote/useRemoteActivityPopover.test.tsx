// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import {
  useRemoteActivityPopover,
  type RemoteActivityPopover
} from "./useRemoteActivityPopover";

/**
 * `useViewportTooltip.show` refuses a trigger that has left the document. A
 * pin whose button was replaced before its card could be drawn must not go on
 * believing it owns one: `settle` answers "did a pinned card take this
 * outcome", and a caller that hears yes skips the toast for a failure.
 */

let popover: RemoteActivityPopover | undefined;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  popover = undefined;
});

function Harness() {
  const p = useRemoteActivityPopover(null);
  popover = p;
  return p.node;
}

const mount = async (): Promise<void> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
};

const scope = { kind: "pull", repoName: "PwrGit", branch: "main" } as const;

it("ends a pin whose trigger is already gone, so settle reports no card took it", async () => {
  await mount();
  const gone = document.createElement("button");
  expect(gone.isConnected).toBe(false);

  await act(async () => popover!.pin(gone, scope));

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(popover!.pinnedKind).toBeNull();
  let carried = true;
  await act(async () => {
    carried = popover!.settle({ status: "error", summary: "Pull failed" });
  });
  expect(carried).toBe(false);
});

it("keeps a pin whose trigger is in the document", async () => {
  await mount();
  const button = document.createElement("button");
  document.body.append(button);

  await act(async () => popover!.pin(button, scope));

  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(popover!.pinnedKind).toBe("pull");
  // Removing the trigger dismisses the card through a MutationObserver.
  await act(async () => button.remove());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(popover!.pinnedKind).toBeNull();
  let carried = true;
  await act(async () => {
    carried = popover!.settle({ status: "error", summary: "Pull failed" });
  });
  expect(carried).toBe(false);
});
