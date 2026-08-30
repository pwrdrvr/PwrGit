// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type AppSettingsSnapshot, type AppUpdateStatus } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { UpdatesSettings } from "./UpdatesSettings";

const snapshot = {
  updates: { train: "stable", channel: "latest" }
} as AppSettingsSnapshot;

const releases = {
  stable: { latest: { version: "v0.9.0" }, prerelease: {} },
  beta: { latest: {}, prerelease: {} },
  fetchedAt: 0
};

let container: HTMLDivElement;
let root: Root;
let statusListener: ((status: AppUpdateStatus) => void) | undefined;

/** Answer the panel's boot reads; `status` is what main reports on mount. */
function bootWith(status: AppUpdateStatus): void {
  mocks.dispatch.mockImplementation((name: string) => {
    if (name === "app:readUpdateStatus") return Promise.resolve(ok(status));
    if (name === "app:readUpdateReleases") return Promise.resolve(ok(releases));
    return Promise.resolve(ok({ status: "restarting" }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith(label)
  );
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <UpdatesSettings
        saving={false}
        snapshot={snapshot}
        onSelectionChange={() => undefined}
      />
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  statusListener = undefined;
  mocks.subscribe.mockImplementation(
    (_channel: string, cb: (status: AppUpdateStatus) => void) => {
      statusListener = cb;
      return () => undefined;
    }
  );
  bootWith({ status: "idle" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("UpdatesSettings", () => {
  it("offers Restart only once an update is downloaded", async () => {
    await render();
    expect(button("Restart to Update")).toBeUndefined();

    await act(async () => {
      statusListener?.({ status: "downloaded", version: "0.9.0" });
    });

    expect(button("Restart to Update")?.textContent).toBe(
      "Restart to Update (0.9.0)"
    );
  });

  it("shows a downloaded update that landed before the panel opened", async () => {
    bootWith({ status: "downloaded", version: "0.9.0" });

    await render();

    expect(button("Restart to Update")).toBeDefined();
  });

  it("surfaces a refused restart and lets the user try again", async () => {
    bootWith({ status: "downloaded", version: "0.9.0" });
    await render();
    mocks.dispatch.mockResolvedValue(
      ok({
        status: "error",
        message: "Dev preview (v420.0.0): Restart only works in production builds."
      })
    );

    await act(async () => button("Restart to Update")?.click());

    expect(mocks.dispatch).toHaveBeenLastCalledWith(
      "app:installUpdate",
      undefined
    );
    expect(container.textContent).toContain("Dev preview (v420.0.0)");
    expect(button("Restart to Update")?.disabled).toBe(false);
  });

  it("drops a stale restart error when a newer update is offered", async () => {
    bootWith({ status: "downloaded", version: "0.9.0" });
    await render();
    mocks.dispatch.mockResolvedValue(
      ok({ status: "error", message: "Restart refused." })
    );
    await act(async () => button("Restart to Update")?.click());
    expect(container.textContent).toContain("Restart refused.");

    await act(async () => {
      statusListener?.({ status: "downloaded", version: "1.0.0" });
    });

    // The previous version's failure says nothing about this one.
    expect(container.textContent).not.toContain("Restart refused.");
    expect(button("Restart to Update")?.textContent).toBe(
      "Restart to Update (1.0.0)"
    );
  });

  it("reports the answer to a check the user asked for", async () => {
    await render();
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "app:checkForUpdate") {
        return Promise.resolve(ok({ status: "no-update", version: "0.9.0" }));
      }
      return Promise.resolve(ok(releases));
    });

    await act(async () => button("Check for Update")?.click());

    expect(container.textContent).toContain("You're up to date (v0.9.0).");
  });
});
