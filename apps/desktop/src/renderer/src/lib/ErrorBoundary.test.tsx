// @vitest-environment jsdom

import { act, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("./pwrgit", () => ({ dispatch: dispatchMock }));

import { ErrorBoundary } from "./ErrorBoundary";
import {
  installRendererErrorReporting,
  rendererRootErrorOptions,
  reportRendererError
} from "./renderer-errors";
import {
  PaneErrorFallback,
  RootErrorFallback
} from "../features/shell/ErrorFallbacks";

function Thrower({ message }: { message: string }): never {
  throw new Error(message);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  dispatchMock.mockResolvedValue(ok(null));
  // The root callbacks still write to the console for DevTools; keep the
  // test output to what it asserts.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  // The same options main.tsx passes, so a catch takes the real logging path.
  root = createRoot(container, rendererRootErrorOptions);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  dispatchMock.mockReset();
});

const reports = () =>
  dispatchMock.mock.calls.filter(([name]) => name === "logs:reportRendererError");

describe("ErrorBoundary", () => {
  it("draws the fallback in place of a child that throws while rendering, and logs it with the component stack", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <main>
          <p>Sidebar survives</p>
          <ErrorBoundary
            fallback={({ error, reset }) => (
              <PaneErrorFallback
                title="Diff"
                error={error}
                onRetry={reset}
                onClose={onClose}
              />
            )}
          >
            <Thrower message="lightbox exploded" />
          </ErrorBoundary>
        </main>
      )
    );

    // The rest of the window is still there; the pane says what happened.
    expect(container.textContent).toContain("Sidebar survives");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "lightbox exploded"
    );

    expect(reports()).toHaveLength(1);
    const [, report] = reports()[0]!;
    expect(report).toMatchObject({
      source: "react-caught",
      message: "Error: lightbox exploded"
    });
    expect(report.stack).toContain("lightbox exploded");
    // The component stack is what says WHERE — the JS stack alone points into
    // React's reconciler.
    expect(report.componentStack).toContain("Thrower");
    expect(report.componentStack).toContain("ErrorBoundary");
  });

  it("closes the pane fallback on Escape and from its close button", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <PaneErrorFallback title="Diff" error={error} onRetry={reset} onClose={onClose} />
          )}
        >
          <Thrower message="boom" />
        </ErrorBoundary>
      )
    );
    const pane = container.querySelector<HTMLElement>(".pane-error")!;
    // It takes focus, so Escape has somewhere to land.
    expect(document.activeElement).toBe(pane);
    const escape = async (claim: boolean): Promise<void> => {
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        // A hover card the keyboard summoned claims the key from its own
        // window listener, after this pane's — hence the deferred check.
        if (claim) window.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
        pane.dispatchEvent(event);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await escape(true);
    expect(onClose).not.toHaveBeenCalled();
    await escape(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("tries again on Try again, and on its own when the reset key changes", async () => {
    let broken = true;
    function Flaky({ label }: { label: string }) {
      if (broken) throw new Error(`broken ${label}`);
      return <p>showing {label}</p>;
    }
    let setTarget: (value: string) => void = () => undefined;
    function Host() {
      const [target, set] = useState("a.png");
      setTarget = set;
      return (
        <ErrorBoundary
          resetKey={target}
          fallback={({ error, reset }) => (
            <PaneErrorFallback title="Diff" error={error} onRetry={reset} onClose={() => undefined} />
          )}
        >
          <Flaky label={target} />
        </ErrorBoundary>
      );
    }
    await act(async () => root.render(<Host />));
    expect(container.textContent).toContain("broken a.png");

    broken = false;
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Try again")!
        .click();
    });
    expect(container.textContent).toContain("showing a.png");

    broken = true;
    await act(async () => setTarget("b.png"));
    expect(container.textContent).toContain("broken b.png");
    broken = false;
    await act(async () => setTarget("c.png"));
    expect(container.textContent).toContain("showing c.png");
  });

  it("calls onError so an owner can close what broke", async () => {
    const onError = vi.fn();
    await act(async () =>
      root.render(
        <ErrorBoundary fallback={() => null} onError={onError}>
          <Thrower message="lightbox exploded" />
        </ErrorBoundary>
      )
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "lightbox exploded" }));
    expect(container.innerHTML).toBe("");
  });

  it("offers Reload at the root, and leaves out Show logs in the Logs window", async () => {
    await act(async () =>
      root.render(
        <ErrorBoundary fallback={({ error }) => <RootErrorFallback error={error} showLogs={false} />}>
          <Thrower message="root exploded" />
        </ErrorBoundary>
      )
    );
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Reload"]);
    expect(container.textContent).toContain("root exploded");
  });

  it("keeps Linux's painted caption buttons, since the title bar that drew them is gone", async () => {
    const runWindowControl = vi.fn(async () => undefined);
    const scope = window as unknown as { pwrgit?: unknown };
    scope.pwrgit = {
      platform: "linux",
      runWindowControl,
      readWindowFrameState: async () => null,
      onWindowFrameState: () => () => undefined
    };
    try {
      await act(async () =>
        root.render(
          <ErrorBoundary fallback={({ error }) => <RootErrorFallback error={error} showLogs />}>
            <Thrower message="root exploded" />
          </ErrorBoundary>
        )
      );
      const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
      expect(close).not.toBeNull();
      await act(async () => close!.click());
      expect(runWindowControl).toHaveBeenCalledWith("close");
    } finally {
      delete scope.pwrgit;
    }
  });
});

// Inside act(), React hands an error no boundary caught to act's own queue and
// rethrows it there instead of calling `onUncaughtError` — so the uncaught
// path can only be exercised the way the app meets it, outside act.
async function renderOutsideAct(node: ReactNode): Promise<void> {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  scope.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    flushSync(() => root.render(node));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    scope.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

describe("renderer error reporting", () => {
  it("reports an error no boundary caught, with its component stack", async () => {
    await renderOutsideAct(<Thrower message="nobody caught me" />);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]![1]).toMatchObject({
      source: "react-uncaught",
      message: "Error: nobody caught me",
      componentStack: expect.stringContaining("Thrower")
    });
  });

  it("forwards window errors and unhandled rejections", () => {
    const uninstall = installRendererErrorReporting(window);
    try {
      window.dispatchEvent(
        new ErrorEvent("error", { error: new Error("click handler threw"), message: "click handler threw" })
      );
      // jsdom has no PromiseRejectionEvent constructor; the listener reads
      // only `reason`.
      const rejection = Object.assign(new Event("unhandledrejection"), {
        reason: new Error("nobody awaited me")
      });
      window.dispatchEvent(rejection);
    } finally {
      uninstall();
    }
    expect(reports().map(([, report]) => [report.source, report.message])).toEqual([
      ["window-error", "Error: click handler threw"],
      ["unhandled-rejection", "Error: nobody awaited me"]
    ]);
  });

  it("handles a failed report itself, so it cannot become an unhandled rejection that reports itself", () => {
    const rejected = Promise.reject(new Error("bridge gone"));
    const handled = vi.spyOn(rejected, "catch");
    dispatchMock.mockReturnValueOnce(rejected);
    reportRendererError("window-error", new Error("first"));
    expect(handled).toHaveBeenCalledTimes(1);

    dispatchMock.mockImplementationOnce(() => {
      throw new TypeError("window.pwrgit is undefined");
    });
    expect(() => reportRendererError("window-error", new Error("second"))).not.toThrow();
  });

  it("reports one error object once, whichever hooks see it", () => {
    const error = new Error("seen twice");
    reportRendererError("react-caught", error, "\n    at Thrower");
    reportRendererError("unhandled-rejection", error);
    expect(reports()).toHaveLength(1);
  });
});
