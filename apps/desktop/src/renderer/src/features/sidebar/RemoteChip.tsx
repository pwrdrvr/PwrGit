import { forgeLabel, type ForgeKind } from "@pwrgit/shared";
import { hoverTooltip, type ViewportTooltip } from "../../lib/useViewportTooltip";
import { ForgeMark } from "./ForgeMark";

/**
 * Which remote listed a change request: the forge's mark and the remote's
 * name. Drawn only where more than one remote lists change requests and
 * nothing else on screen already says which one this is (a lens on one
 * remote does). The mark is what tells a GitHub `origin` from a GitLab
 * `mirror`; the name is what `git` calls it here.
 */
export function RemoteChip({
  remote,
  forge,
  tip
}: {
  remote: string;
  forge: ForgeKind;
  tip: Pick<ViewportTooltip, "show" | "hide" | "hideFrom">;
}) {
  return (
    <span
      className="ref-cr-remote"
      {...hoverTooltip(tip, `Listed on ${remote} (${forgeLabel(forge)})`)}
    >
      <ForgeMark kind={forge} size={10} />
      <span className="ref-cr-remote__name">{remote}</span>
    </span>
  );
}
