import { dispatch } from "../../lib/pwrgit";

/** Platform-appropriate label for "show this path in the OS file manager". */
export const revealLabel =
  typeof navigator === "undefined"
    ? "Show in folder"
    : navigator.platform.startsWith("Mac")
      ? "Reveal in Finder"
      : navigator.platform.startsWith("Win")
        ? "Show in Explorer"
        : "Show in folder";

export function revealPath(path: string): void {
  void dispatch("shell:revealPath", { path });
}
