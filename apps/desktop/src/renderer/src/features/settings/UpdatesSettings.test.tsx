// @vitest-environment jsdom

// Settings → Updates: the four-slot release matrix.
//
// What this pins:
//   • all four published versions are on screen at once, each on its own
//     tile — the reporting bug that motivated the rewrite was Beta reading
//     "Unavailable" while Beta/Prerelease held a shipped alpha;
//   • an empty slot says WHY it is empty and stays clickable;
//   • a tile click writes BOTH axes in one patch (main derives the
//     `selectionSource: "user"` pin from that write, so the renderer must
//     never send a half selection);
//   • the tile matching the running binary is marked Installed;
//   • an unpinned selection says so, a pinned one stays quiet;
//   • check / restart still dispatch the bus verbs they always did.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type AppSettingsSnapshot,
  type AppUpdateStatus,
  type UpdateChannel,
  type UpdateSelectionSource,
  type UpdateTrain
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));

import { UpdatesSettings } from "./UpdatesSettings";

function snapshotWith(
  updates: {
    train: UpdateTrain;
    channel: UpdateChannel;
    selectionSource: UpdateSelectionSource;
  } = { train: "stable", channel: "latest", selectionSource: "inferred" }
): AppSettingsSnapshot {
  return { updates } as AppSettingsSnapshot;
}

/** Beta Latest is deliberately EMPTY while Beta Prerelease carries a build —
 *  that is the exact shape the old two-control UI mislabelled. */
const releases = {
  stable: {
    latest: { version: "v1.0.3" },
    prerelease: { version: "v1.0.3" }
  },
  beta: {
    latest: { unavailableReason: "No beta release found." },
    prerelease: { version: "v1.1.0-alpha.6" }
  },
  fetchedAt: 0
};

let container: HTMLDivElement;
let root: Root;
let statusListener: ((status: AppUpdateStatus) => void) | undefined;
const onSelectionChange = vi.fn();

/** Answer the panel's boot reads; `status` is what main reports on mount. */
function bootWith(
  status: AppUpdateStatus,
  options: { appVersion?: string; releasesFail?: boolean } = {}
): void {
  mocks.dispatch.mockImplementation((name: string) => {
    if (name === "app:readUpdateStatus") return Promise.resolve(ok(status));
    if (name === "app:readUpdateReleases") {
      return Promise.resolve(
        options.releasesFail === true
          ? err({ kind: "internal", message: "bridge closed" })
          : ok(releases)
      );
    }
    if (name === "app:readIdentity") {
      return Promise.resolve(
        ok({ version: options.appVersion ?? "0.9.0" })
      );
    }
    return Promise.resolve(ok({ status: "restarting" }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith(label)
  );
}

/** Tiles are addressed by their aria-label, the only thing that identifies a
 *  slot independently of whatever version it resolved to. */
function slot(train: string, channel: string): HTMLButtonElement {
  const tile = [
    ...container.querySelectorAll<HTMLButtonElement>("button.settings-slot")
  ].find((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith(`${train} ${channel} —`)
  );
  if (!tile) throw new Error(`no ${train} ${channel} tile`);
  return tile;
}

async function render(
  snapshot: AppSettingsSnapshot = snapshotWith()
): Promise<void> {
  await act(async () => {
    root.render(
      <UpdatesSettings
        saving={false}
        snapshot={snapshot}
        onSelectionChange={onSelectionChange}
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

describe("UpdatesSettings — release matrix", () => {
  it("renders all four slots with their own resolved version", async () => {
    await render();

    expect(slot("Stable", "Latest").textContent).toContain("v1.0.3");
    expect(slot("Stable", "Prerelease").textContent).toContain("v1.0.3");
    expect(slot("Beta", "Prerelease").textContent).toContain("v1.1.0-alpha.6");
    // The one empty slot says WHY, and says it on itself rather than hiding
    // the sibling that does have a build.
    expect(slot("Beta", "Latest").textContent).toContain("Unavailable");
    expect(slot("Beta", "Latest").textContent).toContain(
      "No beta release found."
    );
  });

  it("does not let an empty Beta Latest hide the alpha next to it", async () => {
    // Regression for the two-control layout: the Beta button could only label
    // itself with Beta/Latest, so a shipped alpha read as "Beta — Unavailable".
    await render(
      snapshotWith({
        train: "beta",
        channel: "latest",
        selectionSource: "user"
      })
    );

    expect(slot("Beta", "Latest").classList.contains("is-selected")).toBe(true);
    expect(slot("Beta", "Prerelease").textContent).toContain("v1.1.0-alpha.6");
  });

  it("marks the running build's slot as installed", async () => {
    bootWith({ status: "idle" }, { appVersion: "1.1.0-alpha.6" });
    await render();

    expect(slot("Beta", "Prerelease").textContent).toContain("Installed");
    expect(slot("Stable", "Latest").textContent).not.toContain("Installed");
  });

  it("writes both axes in one patch when a tile is clicked", async () => {
    await render();

    await act(async () => slot("Beta", "Prerelease").click());

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith({
      train: "beta",
      channel: "prerelease"
    });
  });

  it("marks the selected slot and keeps an empty one clickable", async () => {
    await render(
      snapshotWith({
        train: "beta",
        channel: "prerelease",
        selectionSource: "user"
      })
    );

    expect(slot("Beta", "Prerelease").getAttribute("aria-checked")).toBe("true");
    expect(slot("Stable", "Latest").getAttribute("aria-checked")).toBe("false");

    const empty = slot("Beta", "Latest");
    expect(empty.disabled).toBe(false);
    await act(async () => empty.click());

    expect(onSelectionChange).toHaveBeenCalledWith({
      train: "beta",
      channel: "latest"
    });
  });

  // "Loading" and "Unavailable" are different claims. A dispatch that FAILS
  // still settles the read, so the tiles must stop claiming a read is in
  // flight — otherwise the pane lies for the lifetime of the window.
  it("falls out of Loading when the release read fails", async () => {
    bootWith({ status: "idle" }, { releasesFail: true });
    await render();

    for (const [train, channel] of [
      ["Stable", "Latest"],
      ["Stable", "Prerelease"],
      ["Beta", "Latest"],
      ["Beta", "Prerelease"]
    ] as const) {
      expect(slot(train, channel).textContent).toContain("Unavailable");
      expect(slot(train, channel).textContent).not.toContain("Loading");
    }
    expect(container.textContent).toContain(
      "Could not read published releases: bridge closed"
    );
  });

  it("moves focus across the matrix without changing the selection", async () => {
    await render(
      snapshotWith({
        train: "stable",
        channel: "latest",
        selectionSource: "user"
      })
    );

    // Roving tabindex: only the selected tile is in the tab order.
    expect(slot("Stable", "Latest").tabIndex).toBe(0);
    expect(slot("Beta", "Prerelease").tabIndex).toBe(-1);

    slot("Stable", "Latest").focus();
    await act(async () => {
      slot("Stable", "Latest").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(document.activeElement).toBe(slot("Beta", "Latest"));

    await act(async () => {
      slot("Beta", "Latest").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
    });
    expect(document.activeElement).toBe(slot("Beta", "Prerelease"));

    // Focus moved; the feed did NOT. Selecting rewrites which build the app
    // installs, so it waits for a real activation.
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(slot("Stable", "Latest").getAttribute("aria-checked")).toBe("true");
  });

  it("says the selection is still inferred until it is pinned", async () => {
    await render();
    expect(container.textContent).toContain(
      "Following the build you installed"
    );

    await render(
      snapshotWith({
        train: "stable",
        channel: "latest",
        selectionSource: "user"
      })
    );
    expect(container.textContent).not.toContain(
      "Following the build you installed"
    );
  });
});

describe("UpdatesSettings — check and install", () => {
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

  it("refreshes the slot versions from the check's warm cache", async () => {
    bootWith({ status: "idle" }, { releasesFail: true });
    await render();
    expect(slot("Stable", "Latest").textContent).toContain("Unavailable");

    bootWith({ status: "idle" });
    mocks.dispatch.mockImplementation((name: string) => {
      if (name === "app:checkForUpdate") {
        return Promise.resolve(ok({ status: "no-update", version: "0.9.0" }));
      }
      return Promise.resolve(ok(releases));
    });

    await act(async () => button("Check for Update")?.click());

    expect(slot("Stable", "Latest").textContent).toContain("v1.0.3");
    expect(container.textContent).not.toContain(
      "Could not read published releases"
    );
  });
});
