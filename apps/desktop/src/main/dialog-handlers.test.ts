import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn()
}));

vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "home" ? "/Users/test" : "") },
  BrowserWindow: {
    getFocusedWindow: mocks.getFocusedWindow,
    getAllWindows: mocks.getAllWindows
  },
  dialog: { showOpenDialog: mocks.showOpenDialog }
}));

vi.mock("./logs", () => ({ logMain: vi.fn() }));

const { CommandBus } = await import("./command-bus");
const { registerDialogHandlers } = await import("./dialog-handlers");

function bus() {
  const value = new CommandBus();
  registerDialogHandlers(value);
  return value;
}

function defaultPathOfCall(index: number): unknown {
  return mocks.showOpenDialog.mock.calls[index]?.[0]?.defaultPath;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFocusedWindow.mockReturnValue(null);
  mocks.getAllWindows.mockReturnValue([]);
});

describe("dialog:pickDirectories", () => {
  it("starts in the home directory rather than Electron's Downloads default", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    const result = await bus().dispatch("dialog:pickDirectories", undefined);

    expect(result).toEqual({ ok: true, value: [] });
    expect(defaultPathOfCall(0)).toBe("/Users/test");
  });

  it("reopens beside the last folder picked", async () => {
    const commands = bus();
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/Users/test/src/pwrgit", "/Users/test/src/pwrsnap"]
    });
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(
      commands.dispatch("dialog:pickDirectories", undefined)
    ).resolves.toEqual({
      ok: true,
      value: ["/Users/test/src/pwrgit", "/Users/test/src/pwrsnap"]
    });
    await commands.dispatch("dialog:pickDirectories", undefined);

    expect(defaultPathOfCall(1)).toBe("/Users/test/src");
  });

  it("keeps the last location when a pick is canceled", async () => {
    const commands = bus();
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: ["/work/a/repo"] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await commands.dispatch("dialog:pickDirectories", undefined);
    await commands.dispatch("dialog:pickDirectories", undefined);
    await commands.dispatch("dialog:pickDirectories", undefined);

    expect(defaultPathOfCall(2)).toBe("/work/a");
  });
});
