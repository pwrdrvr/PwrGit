// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, pwrGitError, type Res } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));

import { describeVersion, GitRuntimeSettings } from "./GitRuntimeSettings";

type Status = Res<"git:runtimeStatus">;

// Contrived, but in the shapes the probes really return: `git lfs version`
// carries a build tail that `git --version` does not.
const HEALTHY: Status = {
  active: "bundled",
  default: "bundled",
  path: "/fixture/git/bin/git",
  bundled: {
    git: "git version 2.50.9",
    lfs: "git-lfs/3.6.9 (GitHub; fixture arm64; go 1.0.0)"
  },
  installed: {
    git: "git version 2.40.9",
    lfs: "git-lfs/3.5.9 (GitHub; fixture arm64; go 1.0.0)"
  }
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue(ok(HEALTHY));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<GitRuntimeSettings />);
  });
}

function chip(): HTMLElement | null {
  return container.querySelector(".settings-card__chip");
}

function values(): string[] {
  return Array.from(
    container.querySelectorAll(".settings-field__value"),
    (value) => value.textContent ?? ""
  );
}

function details(): string[] {
  return Array.from(
    container.querySelectorAll(".settings-field__detail"),
    (detail) => detail.textContent ?? ""
  );
}

function field(label: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>(".settings-field")).find(
    (candidate) =>
      candidate.querySelector(".settings-field__label > span")?.textContent === label
  );
  if (match === undefined) throw new Error(`Field not found: ${label}`);
  return match;
}

describe("describeVersion", () => {
  it("reduces git's sentence to its version, and drops output that adds nothing", () => {
    expect(describeVersion("git", "git version 2.53.0")).toEqual({ version: "2.53.0" });
    // Git for Windows keeps its build suffix in the version itself.
    expect(describeVersion("git", "git version 2.53.0.windows.1")).toEqual({
      version: "2.53.0.windows.1"
    });
  });

  it("keeps LFS's build tail as the detail line", () => {
    expect(
      describeVersion("lfs", "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)\n")
    ).toEqual({
      version: "3.7.1",
      detail: "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)"
    });
  });

  it("shows output in a shape it does not know whole, rather than guessing", () => {
    expect(describeVersion("git", "hub version 2.14.2")).toEqual({
      version: "hub version 2.14.2"
    });
  });
});

describe("GitRuntimeSettings", () => {
  it("names the runtime in use and keeps bundled and installed versions distinct", async () => {
    await render();

    expect(mocks.dispatch).toHaveBeenCalledWith("git:runtimeStatus", undefined);
    expect(chip()?.textContent).toBe("Bundled");
    expect(chip()?.className).toBe("settings-card__chip");
    expect(values()).toEqual(["2.50.9", "3.6.9", "2.40.9", "3.5.9"]);
    // The path, and each LFS build tail; git's own sentence adds nothing.
    expect(details()).toEqual([
      "/fixture/git/bin/git",
      "git-lfs/3.6.9 (GitHub; fixture arm64; go 1.0.0)",
      "git-lfs/3.5.9 (GitHub; fixture arm64; go 1.0.0)"
    ]);
    expect(container.textContent).not.toContain("git version");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("says the installed caveat once, for the pair", async () => {
    await render();

    expect(container.querySelectorAll(".settings-field__sub")).toHaveLength(1);
    expect(field("Installed Git").textContent).toContain("never runs an installed Git or Git LFS");
    expect(field("Installed Git LFS").querySelector(".settings-field__sub")).toBeNull();
  });

  it("reads nothing installed as absence, not as a fault", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({ ...HEALTHY, installed: { git: null, lfs: null } })
    );
    await render();

    expect(chip()?.textContent).toBe("Bundled");
    const absent = Array.from(
      container.querySelectorAll(".settings-field__value--absent"),
      (value) => value.textContent
    );
    expect(absent).toEqual(["Not installed", "Not installed"]);
    expect(container.querySelector(".settings-field__error")).toBeNull();
  });

  it("turns the chip red when the bundled Git cannot run", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({ ...HEALTHY, bundled: { git: null, lfs: null } })
    );
    await render();

    expect(chip()?.textContent).toBe("Unavailable");
    expect(chip()?.classList.contains("settings-card__chip--err")).toBe(true);
    expect(field("Bundled Git").querySelector(".settings-field__error")?.textContent).toContain(
      "repository operations will fail"
    );
    // One statement of the outage: LFS does not add a second one.
    expect(container.querySelectorAll(".settings-field__error")).toHaveLength(1);
    expect(field("Bundled Git").textContent).toContain("/fixture/git/bin/git");
  });

  it("flags a missing bundled Git LFS on its own row, without changing the chip", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({ ...HEALTHY, bundled: { git: HEALTHY.bundled.git, lfs: null } })
    );
    await render();

    expect(chip()?.textContent).toBe("Bundled");
    expect(
      field("Bundled Git LFS").querySelector(".settings-field__error")?.textContent
    ).toContain("Git LFS will fail");
  });

  it("offers Try again when the probe itself fails, and says it could not look", async () => {
    mocks.dispatch
      .mockResolvedValueOnce(err(pwrGitError("unknown", "probe_failed", "Probe timed out.")))
      .mockResolvedValueOnce(ok(HEALTHY));
    await render();

    expect(chip()?.textContent).toBe("Unknown");
    expect(chip()?.classList.contains("settings-card__chip--warn")).toBe(true);
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Git versions couldn’t be read");
    expect(alert?.textContent).toContain("Probe timed out.");

    const retry = alert?.querySelector("button");
    await act(async () => retry?.click());

    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(chip()?.textContent).toBe("Bundled");
    expect(values()[0]).toBe("2.50.9");
  });

  it("shows no chip, and a quiet status line, while the first probe is in flight", async () => {
    mocks.dispatch.mockReturnValue(new Promise(() => {}));
    await render();

    expect(chip()).toBeNull();
    const status = container.querySelector("[role='status']");
    expect(status?.textContent).toBe("Checking Git versions…");
    expect(status?.classList.contains("settings-empty")).toBe(true);
  });
});
