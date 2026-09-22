// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, pwrGitError, type Res } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));

import { describeVersion, GitRuntimeSettings } from "./GitRuntimeSettings";

type Status = Res<"git:runtimeStatus">;

const BUNDLED = "/fixture/PwrGit.app/Contents/Resources/git/bin/git";

// Contrived, but in the shapes the probes really return: `git lfs version`
// carries a build tail that `git --version` does not.
const HEALTHY: Status = {
  active: "bundled",
  path: BUNDLED,
  keychainHelper: "/fixture/homebrew/Cellar/git/2.40.9/libexec/git-core/git-credential-osxkeychain",
  candidates: [
    {
      path: BUNDLED,
      source: "bundled",
      git: "git version 2.50.9",
      lfs: "git-lfs/3.6.9 (GitHub; fixture arm64; go 1.0.0)",
      problem: null
    },
    {
      path: "/fixture/homebrew/bin/git",
      source: "homebrew",
      git: "git version 2.40.9",
      lfs: "git-lfs/3.5.9 (GitHub; fixture arm64; go 1.0.0)",
      problem: null
    },
    {
      path: "/fixture/Developer/usr/bin/git",
      source: "xcode",
      git: "git version 2.30.9 (Apple Git-1)",
      lfs: null,
      problem: "lfs_missing"
    }
  ]
};

const HOMEBREW_SELECTED: Status = {
  ...HEALTHY,
  active: "installed",
  path: "/fixture/homebrew/bin/git"
};

let container: HTMLDivElement;
let root: Root;

function installBridge(platform: string): void {
  (window as unknown as { pwrgit: { platform: string } }).pwrgit = { platform };
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge("darwin");
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

function rows(): Array<{ path: string; meta: string; action: string }> {
  return Array.from(container.querySelectorAll(".settings-ai-install"), (row) => ({
    path: row.querySelector(".settings-ai-install__path")?.textContent ?? "",
    meta: row.querySelector(".settings-ai-install__meta")?.textContent ?? "",
    action: row.querySelector("button, .settings-card__chip")?.textContent ?? ""
  }));
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name
  );
  if (match === undefined) throw new Error(`Button not found: ${name}`);
  return match;
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
  it("names the runtime in use, its versions, and every Git it could run instead", async () => {
    await render();

    expect(mocks.dispatch).toHaveBeenCalledWith("git:runtimeStatus", undefined);
    expect(chip()?.textContent).toBe("Bundled");
    expect(chip()?.className).toBe("settings-card__chip");
    expect(values().slice(0, 2)).toEqual(["2.50.9", "3.6.9"]);
    expect(details()).toContain(BUNDLED);
    expect(details()).toContain("git-lfs/3.6.9 (GitHub; fixture arm64; go 1.0.0)");
    expect(rows()).toEqual([
      { path: BUNDLED, meta: "Bundled · 2.50.9 · LFS 3.6.9", action: "Using" },
      { path: "/fixture/homebrew/bin/git", meta: "Homebrew · 2.40.9 · LFS 3.5.9", action: "Use" },
      // Listed, so its absence from the choices is explained — never offered.
      { path: "/fixture/Developer/usr/bin/git", meta: "Apple · 2.30.9", action: "LFS missing" }
    ]);
    expect(container.textContent).not.toContain("git version");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("says which keychain helper bundled Git signs in to HTTPS remotes with", async () => {
    await render();

    expect(field("HTTPS sign-in").textContent).toContain("macOS keychain");
    expect(field("HTTPS sign-in").textContent).toContain(HEALTHY.keychainHelper);
  });

  it("says plainly when bundled Git has no keychain helper to sign in with", async () => {
    mocks.dispatch.mockResolvedValue(ok({ ...HEALTHY, keychainHelper: null }));
    await render();

    const signIn = field("HTTPS sign-in");
    expect(signIn.querySelector(".settings-field__value--absent")?.textContent).toBe("No keychain helper");
    expect(signIn.textContent).toContain("use an SSH remote");
    // Guidance, not an outage: the runtime itself still runs.
    expect(chip()?.textContent).toBe("Bundled");
  });

  it("leaves HTTPS sign-in out off macOS, and while an installed Git reads its own config", async () => {
    installBridge("linux");
    await render();
    expect(() => field("HTTPS sign-in")).toThrow();

    installBridge("darwin");
    mocks.dispatch.mockResolvedValue(ok(HOMEBREW_SELECTED));
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(() => field("HTTPS sign-in")).toThrow();
  });

  it("switches to an installed Git from its row, and shows the answer main sends back", async () => {
    await render();
    mocks.dispatch.mockResolvedValueOnce(ok(HOMEBREW_SELECTED));

    await act(async () => button("Use /fixture/homebrew/bin/git").click());

    expect(mocks.dispatch).toHaveBeenLastCalledWith("git:selectRuntime", { path: "/fixture/homebrew/bin/git" });
    expect(chip()?.textContent).toBe("Installed");
    expect(details()).toContain("/fixture/homebrew/bin/git");
    expect(rows().map((row) => row.action)).toEqual(["Use", "Using", "LFS missing"]);
    // The custom-path field names what is in use, so Clear has something to clear.
    expect(container.querySelector<HTMLInputElement>("input[aria-label='Custom Git path']")?.value).toBe(
      "/fixture/homebrew/bin/git"
    );
  });

  it("returns to the bundle through its own row", async () => {
    mocks.dispatch.mockResolvedValueOnce(ok(HOMEBREW_SELECTED)).mockResolvedValueOnce(ok(HEALTHY));
    await render();

    await act(async () => button(`Use ${BUNDLED}`).click());

    expect(mocks.dispatch).toHaveBeenLastCalledWith("git:selectRuntime", { path: null });
    expect(chip()?.textContent).toBe("Bundled");
  });

  it("puts main's refusal beside the list, and changes nothing", async () => {
    await render();
    mocks.dispatch.mockResolvedValueOnce(
      err(pwrGitError("git", "git_runtime_lfs_missing", "/fixture/homebrew/bin/git has no working Git LFS."))
    );

    await act(async () => button("Use /fixture/homebrew/bin/git").click());

    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "/fixture/homebrew/bin/git has no working Git LFS."
    );
    expect(chip()?.textContent).toBe("Bundled");
  });

  it("uses a typed path through the same command", async () => {
    await render();
    mocks.dispatch.mockResolvedValueOnce(ok({ ...HOMEBREW_SELECTED, path: "/opt/fixture/bin/git" }));
    const input = container.querySelector<HTMLInputElement>("input[aria-label='Custom Git path']");
    if (input === null) throw new Error("no custom path field");

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "/opt/fixture/bin/git");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Use path").click());

    expect(mocks.dispatch).toHaveBeenLastCalledWith("git:selectRuntime", { path: "/opt/fixture/bin/git" });
  });

  it("re-checks on request, keeping the last answer on screen meanwhile", async () => {
    await render();
    let answer: (value: unknown) => void = () => undefined;
    mocks.dispatch.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

    await act(async () => button("Re-check").click());

    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(button("Checking…").getAttribute("aria-busy")).toBe("true");
    expect(rows()).toHaveLength(3);
    await act(async () => answer(ok(HEALTHY)));
    expect(button("Re-check")).toBeDefined();
  });

  it("turns the chip red, and says so on the Git row, when the chosen Git cannot run", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({
        ...HEALTHY,
        active: "installed",
        path: "/fixture/removed/git",
        candidates: [
          ...HEALTHY.candidates,
          { path: "/fixture/removed/git", source: "custom", git: null, lfs: null, problem: "not_found" }
        ]
      })
    );
    await render();

    expect(chip()?.textContent).toBe("Unavailable");
    expect(chip()?.classList.contains("settings-card__chip--err")).toBe(true);
    expect(field("Git").querySelector(".settings-field__error")?.textContent).toContain("Choose another Git");
    expect(rows().at(-1)).toEqual({ path: "/fixture/removed/git", meta: "Custom", action: "Not found" });
    // One statement of the outage: LFS does not add a second one.
    expect(container.querySelectorAll(".settings-field__error")).toHaveLength(1);
  });

  it("turns the chip red when the bundled Git cannot run", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({
        ...HEALTHY,
        candidates: [{ path: BUNDLED, source: "bundled", git: null, lfs: null, problem: "no_version" }]
      })
    );
    await render();

    expect(chip()?.textContent).toBe("Unavailable");
    expect(chip()?.classList.contains("settings-card__chip--err")).toBe(true);
    expect(field("Git").querySelector(".settings-field__error")?.textContent).toContain(
      "repository operations will fail"
    );
    expect(container.querySelectorAll(".settings-field__error")).toHaveLength(1);
    expect(field("Git").textContent).toContain(BUNDLED);
  });

  it("flags a missing bundled Git LFS on its own row, without changing the chip", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({
        ...HEALTHY,
        candidates: [{ path: BUNDLED, source: "bundled", git: "git version 2.50.9", lfs: null, problem: "lfs_missing" }]
      })
    );
    await render();

    expect(chip()?.textContent).toBe("Bundled");
    expect(field("Git LFS").querySelector(".settings-field__error")?.textContent).toContain("Git LFS will fail");
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
