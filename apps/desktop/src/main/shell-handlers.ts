import { shell } from "electron";
import { ok } from "@pwrgit/shared";
import type { CommandBus } from "./command-bus";

export function registerShellHandlers(bus: CommandBus): void {
  bus.register("shell:revealPath", (req) => {
    // Highlights the path in its parent folder (Finder / Explorer / the Linux
    // file manager). No-op if the path no longer exists.
    shell.showItemInFolder(req.path);
    return ok(null);
  });
}
