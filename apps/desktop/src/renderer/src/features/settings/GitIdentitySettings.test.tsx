// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERAL_DEFAULTS, ok, type MachineGitIdentity, type Profile } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock("../../lib/pwrgit", () => mocks);
import { GitIdentitySection, setupCommands, setupSeeds } from "./GitIdentitySettings";
import type { AppSettingsState } from "./useAppSettings";

const ROWAN = { name: "Rowan Vale", email: "rowan@vale.example" };
const personal: Profile = {
  id: "personal",
  name: "Personal",
  email: ROWAN.email,
  authorName: ROWAN.name,
  mono: "P",
  roots: [],
  onboardingCompleted: true,
  showInMenu: true
};
const MISSING: MachineGitIdentity = {
  outside: { kind: "missing", message: "no email was given and auto-detection is disabled" },
  config: [],
  globalFile: "/home/rowan/.gitconfig",
  notice: false
};
const CONFIGURED: MachineGitIdentity = {
  ...MISSING,
  outside: { kind: "configured", author: ROWAN, committer: ROWAN },
  config: [
    { key: "user.name", value: ROWAN.name, scope: "global", origin: "/home/rowan/.gitconfig" },
    { key: "user.email", value: ROWAN.email, scope: "global", origin: "/home/rowan/.gitconfig" }
  ]
};

let root: Root;
let container: HTMLDivElement;
const update = vi.fn(async () => undefined);

function settings(): AppSettingsState {
  return {
    snapshot: { general: GENERAL_DEFAULTS } as AppSettingsState["snapshot"],
    loading: false,
    saving: false,
    error: null,
    refresh: async () => undefined,
    update
  };
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockImplementation(async (name: string) => {
    if (name === "identity:machine") return ok(MISSING);
    if (name === "identity:writeGlobal") return ok(CONFIGURED);
    return ok(null);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Settings › Profiles › Git outside PwrGit", () => {
  it("reports an unconfigured Git and writes only after the preview", async () => {
    await act(async () => {
      root.render(<GitIdentitySection machine={MISSING} profiles={[personal]} settings={settings()} />);
    });
    expect(container.textContent).toContain("Not configured");
    expect(container.textContent).toContain("“Author identity unknown”");

    await act(async () => button("Set up Git identity…").click());
    const dialog = container.querySelector("[role='dialog']");
    // Seeded from the profile, and the file named before anything is written.
    expect(dialog?.textContent).toContain("Personal · rowan@vale.example");
    expect(dialog?.textContent).toContain("/home/rowan/.gitconfig");
    expect(dialog?.textContent).toContain("git config --global user.name \"Rowan Vale\"");
    expect(mocks.dispatch).not.toHaveBeenCalledWith("identity:writeGlobal", expect.anything());

    await act(async () => button("Write to Git config").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:writeGlobal", ROWAN);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("says so when the write did not take", async () => {
    mocks.dispatch.mockImplementation(async (name: string) =>
      name === "identity:writeGlobal" || name === "identity:machine" ? ok(MISSING) : ok(null)
    );
    await act(async () => {
      root.render(<GitIdentitySection machine={MISSING} profiles={[personal]} settings={settings()} />);
    });
    await act(async () => button("Set up Git identity…").click());
    await act(async () => button("Write to Git config").click());
    expect(container.querySelector("[role='dialog'] [role='alert']")?.textContent).toBe(
      "Written, but Git still doesn’t resolve an identity."
    );
  });

  it("switches the launch reminder in General settings", async () => {
    await act(async () => {
      root.render(<GitIdentitySection machine={MISSING} profiles={[personal]} settings={settings()} />);
    });
    const toggle = container.querySelector<HTMLButtonElement>("[role='switch']");
    await act(async () => toggle?.click());
    expect(update).toHaveBeenCalledWith({ general: { gitIdentityReminder: false } });
  });
});

describe("the set-up dialog's preview and check", () => {
  it("previews only what the global file holds, never a system value", async () => {
    const systemOnly: MachineGitIdentity = {
      ...MISSING,
      config: [{ key: "user.name", value: "Lab Default", scope: "system", origin: "/etc/gitconfig" }]
    };
    await act(async () => {
      root.render(<GitIdentitySection machine={systemOnly} profiles={[personal]} settings={settings()} />);
    });
    await act(async () => button("Set up Git identity…").click());
    const from = [...container.querySelectorAll(".git-identity-setup__from")].map((cell) => cell.textContent);
    expect(from).toEqual(["not set", "not set"]);
  });

  it("accepts a name Git trims when it prints it", async () => {
    // `git var` drops trailing quotes from an ident name; config keeps them.
    const quoted = 'Rowan "Ro"';
    mocks.dispatch.mockImplementation(async (name: string) =>
      name === "identity:writeGlobal"
        ? ok({
            ...CONFIGURED,
            outside: {
              kind: "configured",
              author: { name: 'Rowan "Ro', email: ROWAN.email },
              committer: { name: 'Rowan "Ro', email: ROWAN.email }
            },
            config: [
              { key: "user.name", value: quoted, scope: "global", origin: "/home/rowan/.gitconfig" },
              { key: "user.email", value: ROWAN.email, scope: "global", origin: "/home/rowan/.gitconfig" }
            ]
          })
        : ok(null)
    );
    await act(async () => {
      root.render(
        <GitIdentitySection
          machine={MISSING}
          profiles={[{ ...personal, authorName: quoted }]}
          settings={settings()}
        />
      );
    });
    await act(async () => button("Set up Git identity…").click());
    await act(async () => button("Write to Git config").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("identity:writeGlobal", { name: quoted, email: ROWAN.email });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});

describe("setupSeeds / setupCommands", () => {
  it("skips profiles without an email and quotes what a shell would need", () => {
    expect(setupSeeds(MISSING, [personal, { ...personal, id: "x", email: "" }])).toEqual([
      { label: "Personal · rowan@vale.example", name: "Rowan Vale", email: "rowan@vale.example" }
    ]);
    expect(setupCommands("Rowan Vale", "rowan@vale.example")).toEqual([
      'git config --global user.name "Rowan Vale"',
      "git config --global user.email rowan@vale.example"
    ]);
  });
});
