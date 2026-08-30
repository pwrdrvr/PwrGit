import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  logMain: vi.fn()
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
  shell: {
    openExternal: mocks.openExternal,
    showItemInFolder: mocks.showItemInFolder
  }
}));

vi.mock("./logs", () => ({ logMain: mocks.logMain }));

const { CommandBus } = await import("./command-bus");
const { registerShellHandlers } = await import("./shell-handlers");

function bus() {
  const value = new CommandBus();
  registerShellHandlers(value);
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openExternal.mockResolvedValue(undefined);
});

describe("shell handlers", () => {
  it("opens an HTTPS URL through Electron and returns after it succeeds", async () => {
    const result = await bus().dispatch("shell:openExternal", {
      url: "https://docs.pwrgit.com"
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://docs.pwrgit.com");
  });

  it("rejects non-web URLs before Electron sees them", async () => {
    const result = await bus().dispatch("shell:openExternal", {
      url: "file:///tmp/private"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "invalid_external_url" }
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("returns a typed browser-launch failure", async () => {
    mocks.openExternal.mockRejectedValue(new Error("offline"));

    const result = await bus().dispatch("shell:openExternal", {
      url: "https://docs.pwrgit.com"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "external_open_failed" }
    });
  });

  it("preserves the reveal-path boundary", async () => {
    await expect(
      bus().dispatch("shell:revealPath", { path: "/tmp/pwrgit.log" })
    ).resolves.toEqual({ ok: true, value: null });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith("/tmp/pwrgit.log");
  });
});
