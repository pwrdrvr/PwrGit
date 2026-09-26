import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  isEmpty: vi.fn(),
  createFromBuffer: vi.fn()
}));

vi.mock("electron", () => ({
  clipboard: { write: mocks.write },
  // Stands in for Electron's class: keeps the MIME-keyed record it was built
  // from, which is all the handler hands to `clipboard.write`.
  ClipboardItem: class {
    constructor(readonly items: Record<string, unknown>) {}
  },
  nativeImage: { createFromBuffer: mocks.createFromBuffer }
}));

vi.mock("./logs", () => ({ logMain: vi.fn() }));

const { CommandBus } = await import("./command-bus");
const { registerClipboardHandlers } = await import("./clipboard-handlers");

function bus() {
  const value = new CommandBus();
  registerClipboardHandlers(value);
  return value;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createFromBuffer.mockReturnValue({ isEmpty: mocks.isEmpty });
  mocks.isEmpty.mockReturnValue(false);
  mocks.write.mockResolvedValue(undefined);
});

describe("clipboard:writeImage", () => {
  it("writes the PNG as a single image/png clipboard item", async () => {
    const result = await bus().dispatch("clipboard:writeImage", {
      pngBase64: PNG_BYTES.toString("base64")
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const [items] = mocks.write.mock.calls[0] as [
      Array<{ items: Record<string, Blob> }>
    ];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0].items)).toEqual(["image/png"]);
    const blob = items[0].items["image/png"];
    expect(blob.type).toBe("image/png");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("refuses bytes Electron cannot decode instead of reporting a copy", async () => {
    mocks.isEmpty.mockReturnValue(true);

    const result = await bus().dispatch("clipboard:writeImage", {
      pngBase64: Buffer.from("not an image").toString("base64")
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "clipboard/undecodable-image" }
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("returns a failure when the system clipboard rejects the write", async () => {
    mocks.write.mockRejectedValue(new Error("pasteboard unavailable"));

    const result = await bus().dispatch("clipboard:writeImage", {
      pngBase64: PNG_BYTES.toString("base64")
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "handler_threw", message: "pasteboard unavailable" }
    });
  });
});
