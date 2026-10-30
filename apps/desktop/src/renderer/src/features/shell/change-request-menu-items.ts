import {
  ASSUMED_FORGE_KIND,
  changeRequestNoun,
  changeRequestSigil,
  type PrSummary
} from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import type { MenuItem } from "./ContextMenu";

/**
 * Open and copy-link entries for one change request, in its forge's words:
 * "Open pull request #12" on GitHub, "Open merge request !12" on GitLab. The
 * graph's menus said "PR #12" on every forge.
 */
export function changeRequestMenuItems(
  pr: Pick<PrSummary, "number" | "url" | "forge">
): MenuItem[] {
  const forge = pr.forge ?? ASSUMED_FORGE_KIND;
  const name = `${changeRequestNoun(forge)} ${changeRequestSigil(forge)}${pr.number}`;
  return [
    {
      type: "item",
      label: `Open ${name}`,
      onSelect: () => void dispatch("shell:openExternal", { url: pr.url })
    },
    {
      type: "item",
      label: `Copy ${name} link`,
      onSelect: () => void copyText(pr.url)
    }
  ];
}
