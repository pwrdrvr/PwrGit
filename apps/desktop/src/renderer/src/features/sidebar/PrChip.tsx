import type { PrSummary } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";

/** A compact PR-status chip: colored dot + #number. Click opens the PR in
 *  the browser; ⌥-click copies its URL. The tooltip carries the full story —
 *  number, title, state, draft. */
export function PrChip({ pr }: { pr: PrSummary }) {
  const label =
    pr.state === "merged"
      ? `merged #${pr.number}`
      : pr.state === "closed"
        ? `closed #${pr.number}`
        : `#${pr.number}`;
  const open = (): void => void dispatch("shell:openExternal", { url: pr.url });
  const activate = (altKey: boolean): void => {
    if (altKey) void copyText(pr.url);
    else open();
  };

  return (
    <span
      className={`pr-chip pr-chip--${pr.state}${pr.isDraft ? " pr-chip--draft" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`PR #${pr.number} (${pr.state}) — Enter opens in browser`}
      title={`#${pr.number} — ${pr.title || "untitled"}\n${pr.state}${
        pr.isDraft ? " · draft" : ""
      }\nClick to open · ⌥-click to copy URL`}
      onClick={(e) => {
        e.stopPropagation();
        activate(e.altKey);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          activate(e.altKey);
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
