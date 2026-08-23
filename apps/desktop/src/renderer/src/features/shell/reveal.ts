import { revealPathLabel } from "../../lib/platform";
import { dispatch } from "../../lib/pwrgit";

/** Platform-appropriate label for "show this path in the OS file manager". */
export const revealLabel = (platform?: string): string =>
  revealPathLabel(platform);

export function revealPath(path: string): void {
  void dispatch("shell:revealPath", { path });
}
