import type { PrSummary } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

/** A compact PR-status chip: colored dot + #number, click to open the PR. */
export function PrChip({ pr }: { pr: PrSummary }) {
  const label =
    pr.state === "merged"
      ? `merged #${pr.number}`
      : pr.state === "closed"
        ? `closed #${pr.number}`
        : `#${pr.number}`;
  const open = (): void => void dispatch("shell:openExternal", { url: pr.url });

  return (
    <span
      className={`pr-chip pr-chip--${pr.state}${pr.isDraft ? " pr-chip--draft" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Open PR #${pr.number} (${pr.state}) in browser`}
      title={`${pr.title || `PR #${pr.number}`}\n${pr.state}${
        pr.isDraft ? " · draft" : ""
      } — click to open`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          open();
        }
      }}
    >
      <span className="pr-chip__dot" aria-hidden="true" />
      <span className="pr-chip__label">{label}</span>
      {pr.isDraft && pr.state === "open" && (
        <span className="pr-chip__draft-bar" aria-hidden="true" />
      )}
    </span>
  );
}
