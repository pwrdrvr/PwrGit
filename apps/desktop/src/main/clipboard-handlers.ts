import { clipboard, nativeImage } from "electron";
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
    const image = nativeImage.createFromBuffer(
      Buffer.from(req.pngBase64, "base64")
    );
    // Electron returns an empty image rather than throwing on bytes it cannot
    // decode, and writing that silently clears whatever the user had copied.
    if (image.isEmpty()) {
      return err(
        pwrGitError(
          "validation",
          "clipboard/undecodable-image",
          "Could not read the image to copy."
        )
      );
    }
    clipboard.writeImage(image);
    return ok(null);
  });
}
