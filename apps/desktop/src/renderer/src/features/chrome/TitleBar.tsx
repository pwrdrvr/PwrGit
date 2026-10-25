import { useRef, useState } from "react";
import type { ChangeRequestEntry, Repo, Worktree } from "@pwrgit/shared";
import { PrChip } from "../sidebar/PrChip";
import {
  currentPlatform,
  pathLeaf,
  pathTail,
  shortcutLabel
} from "../../lib/platform";
import { SearchGlyph } from "../../lib/SearchGlyph";
import { useStepLadder } from "../../lib/useFitLadder";
import { CopyTarget } from "../shell/CopyTarget";
import { BranchSwitcher } from "../graph/BranchSwitcher";
import { AppMenuBar } from "./AppMenuBar";
import { HistoryNavButtons, type HistoryNavControls } from "./HistoryNavButtons";
import { TitleBarBrand } from "./Brand";
import { WindowControls } from "./WindowControls";
import {
  hoverTooltip,
  truncatedTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

/**
 * The window's top strip: wordmark, then the selected worktree's identity as a
 * breadcrumb, then the jump field.
 *
 *   [●●●]  ⑂ PwrGit  ‹ ›  repo › ●branch ▾  [path chip]   …drag…   [⌕ Jump to repo… ⌘F]
 *
 * Pwr-family house chrome, specified in ./AGENTS.md. PwrSnap runs the same
 * full-width bar. (PwrAgnt's `AppTitleBar` is win32-only; on macOS it keeps
 * its wordmark in the sidebar masthead, which has no room for a breadcrumb.
 * PwrGit already had a full-width strip, so the strip is the natural home for
 * per-window context.)
 *
 * The strip is a window-drag region and `-webkit-app-region` INHERITS, so
 * every interactive descendant has to opt back out — see the `no-drag` rules
 * in app.css. Without that the OS claims the middle of each control and only
 * its padding edges stay clickable.
 *
 * Renders the wordmark alone when nothing is selected, so the strip never
 * collapses or shifts height between the empty and selected states.
 */
/** Steps the jump field takes while the crumbs are cut short, in order. */
export const JUMP_FIT_STEPS = [
  "titlebar--jump-no-kbd",
  "titlebar--jump-icon"
] as const;

/** True while no crumb is ellipsized. Each of these clips its own overflow,
 *  so a cut one reads wider than it is drawn. */
function crumbsWhole(strip: HTMLElement | null): boolean {
  if (strip === null) return true;
  const cut = strip.querySelectorAll<HTMLElement>(
    ".titlebar__repo, .titlebar__pathchip, .titlebar__cr-title"
  );
  for (const el of cut) {
    if (el.scrollWidth > el.clientWidth + 0.5) return false;
  }
  return true;
}

export function TitleBar({
  repo,
  worktree,
  history,
  changeRequest,
  onRevealBranchWorktree,
  onOpenContributions,
  contributionsOpen = false,
  onOpenSearch,
  platform = currentPlatform()
}: {
  repo: Repo | null;
  worktree: Worktree | null;
  /** Back/Forward, placed where PwrAgnt places them: at the leading edge of
   *  what they move between. Always drawn, disabled when empty, so the crumbs
   *  never shift as history fills. */
  history?: HistoryNavControls;
  /** A change request on screen instead of the worktree: the crumb names it,
   *  and `repo` is its repository. */
  changeRequest?: ChangeRequestEntry;
  /** Go to the worktree already holding a branch the picker could not check
   *  out. The strip has no worktree list of its own, so the owner resolves it. */
  onRevealBranchWorktree: (branch: string) => void;
  onOpenContributions?: () => void;
  contributionsOpen?: boolean;
  /** Open the ⌘F palette. It searches repositories, branches, pull requests,
   *  commits and files — not a filter on the sidebar's list — so its field
   *  lives in window chrome (design/Sidebar Header Toolbar - UX Review.dc.html,
   *  2b and 3a). Omitted, the strip draws no field. */
  onOpenSearch?: () => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const tip = useViewportTooltip();
  const [switching, setSwitching] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  // The crumbs say where you are; the field is decoration once you know ⌘F.
  // So the field gives way first — key cap, then label — while any crumb is
  // cut short, and only then do the crumbs shrink (3a). Measured, never a
  // window-width breakpoint.
  useStepLadder(stripRef, () => crumbsWhole(stripRef.current), JUMP_FIT_STEPS);

  return (
    <>
      <div className="titlebar" ref={stripRef}>
        {/* macOS-only traffic-light reservation; CSS gives it width there
            and nowhere else. */}
        <div className="titlebar__gutter" />
        <TitleBarBrand />

        {/* macOS keeps File/Edit in the system menu bar. Windows and Linux
            hid the title bar the native row lived in, so the strip paints the
            top-level labels and pops the real submenus. */}
        {platform !== "darwin" && <AppMenuBar />}

        {history !== undefined && (
          <HistoryNavButtons {...history} platform={platform} />
        )}

        {repo !== null && changeRequest !== undefined && (
          <div className="titlebar__id">
            <span
              className="titlebar__repo"
              {...truncatedTooltip(tip, repo.name)}
            >
              {repo.name}
            </span>
            <span aria-hidden="true" className="titlebar__sep">
              ›
            </span>
            <span className="titlebar__cr">
              <PrChip pr={changeRequest.pr} />
              <span
                className="titlebar__cr-title"
                {...truncatedTooltip(tip, changeRequest.pr.title)}
              >
                {changeRequest.pr.title}
              </span>
            </span>
          </div>
        )}

        {repo !== null && worktree !== null && changeRequest === undefined && (
          <div className="titlebar__id">
            <span
              className="titlebar__repo"
              {...truncatedTooltip(tip, repo.name)}
            >
              {repo.name}
            </span>
            <span aria-hidden="true" className="titlebar__sep">
              ›
            </span>
            <button
              className="titlebar__branch"
              {...hoverTooltip(tip, "Switch branch")}
              onClick={() => setSwitching(true)}
            >
              <span className="titlebar__dot" />
              <span className="titlebar__branch-name">{worktree.branch}</span>
              <svg
                className="titlebar__caret"
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <CopyTarget
              value={worktree.path}
              label="Copy worktree path"
              hint={`${worktree.path}\nClick to copy`}
              className="titlebar__pathchip copyable"
              stopPropagation={false}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
              {pathTail(worktree.path, 2, platform)}
            </CopyTarget>
          </div>
        )}

        <div className="titlebar__spacer" />
        {onOpenSearch !== undefined && (
          <button
            type="button"
            className="titlebar-jump"
            /* The label and key cap step out at narrow widths, so the name is
               spelled here rather than read from what happens to be drawn. */
            aria-label="Jump to repo…"
            {...hoverTooltip(
              tip,
              `Jump to a repository, branch, commit or file (${shortcutLabel(
                { key: "F" },
                platform
              )} or ${shortcutLabel({ key: "K" }, platform)})`
            )}
            onClick={onOpenSearch}
          >
            <SearchGlyph size={13} />
            <span className="titlebar-jump__label">Jump to repo…</span>
            {/* Find is advertised; the K chord stays as a silent alias. */}
            <span className="kbd titlebar-jump__kbd" aria-hidden="true">
              {shortcutLabel({ key: "F" }, platform)}
            </span>
          </button>
        )}
        {onOpenContributions && (
          <button
            type="button"
            className="contributions-nav"
            data-contributions-nav
            aria-label="Contributions"
            aria-pressed={contributionsOpen}
            onClick={onOpenContributions}
            {...hoverTooltip(tip, "Contributions")}
          >
            {/* Lucide chart-column, drawn like the history chevrons. */}
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 3v16a2 2 0 0 0 2 2h16" />
              <path d="M18 17V9" />
              <path d="M13 17V5" />
              <path d="M8 17v-3" />
            </svg>
          </button>
        )}

        {/* Linux frameless windows get neither traffic lights nor a Windows
            controls overlay — nobody draws min/max/close but us. */}
        {platform === "linux" && <WindowControls />}
      </div>

      {/* Sibling of the strip, never inside it: a full-window modal nested in
          a drag region has every pixel claimed by the OS — the search input
          never takes focus, Escape never reaches its handler, and clicking a
          row drags the window instead of switching branches. */}
      {switching && worktree !== null && (
        <BranchSwitcher
          worktreeId={worktree.id}
          worktreeLabel={pathLeaf(worktree.path)}
          currentBranch={worktree.branch}
          onHeldElsewhere={onRevealBranchWorktree}
          onClose={() => setSwitching(false)}
        />
      )}
      {tip.tooltipNode}
    </>
  );
}
