import { clipboard, ClipboardItem, nativeImage } from "electron";
import { err, ok, pwrGitError } from "@pwrgit/shared";
import type { CommandBus } from "./command-bus";

/**
 * The system clipboard, for pictures the renderer has composed.
 *
 * It goes through the main process rather than `navigator.clipboard.write`
 * because a packaged renderer is loaded from `file://`, which is not a secure
 * context — the Async Clipboard API is simply absent there, so the browser path
 * would work in `pnpm dev` and fail in every shipped build.
 */
export function registerClipboardHandlers(bus: CommandBus): void {
  bus.register("clipboard:writeImage", async (req) => {
    const png = Buffer.from(req.pngBase64, "base64");
    // Electron returns an empty image rather than throwing on bytes it cannot
    // decode, and `clipboard.write` skips an image it cannot decode without
    // rejecting — so a copy of bad bytes would report success having copied
    // nothing.
    if (nativeImage.createFromBuffer(png).isEmpty()) {
      return err(
        pwrGitError(
          "validation",
          "clipboard/undecodable-image",
          "Could not read the image to copy."
        )
      );
    }
    // Electron 44 removed `clipboard.writeImage`. An `image/png` entry is
    // decoded by the same helper `nativeImage.createFromBuffer` uses and
    // written to the pasteboard as a bitmap, as `writeImage` did.
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })
    ]);
    return ok(null);
  });
}
