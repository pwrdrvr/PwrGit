import { useState } from "react";
import type { Repo, Worktree } from "@pwrgit/shared";
import { CopyTarget } from "../shell/CopyTarget";
import { BranchSwitcher } from "../graph/BranchSwitcher";
import { AppMenuBar } from "./AppMenuBar";

/** Compact path label: the last two segments locate a checkout precisely
 *  ("Acme/search-compare", "pwrdrvr/PwrAgnt") without burning a line on
 *  the full path — that lives in the tooltip, and click copies it. */
function pathTail(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.slice(-2).join("/");
}

/**
 * The window's top strip: wordmark, then the selected worktree's identity as a
 * breadcrumb.
 *
 *   [●●●]  PwrGit   repo › ●branch ▾  [path chip]        …drag…
 *
 * Pwr-family house chrome — PwrSnap runs the same full-width bar. (PwrAgnt's
 * `AppTitleBar` is win32-only; on macOS it keeps its wordmark in the sidebar
 * masthead, which has no room for a breadcrumb. PwrGit already had a
 * full-width strip, so the strip is the natural home for per-window context.)
 *
 * The strip is a window-drag region and `-webkit-app-region` INHERITS, so
 * every interactive descendant has to opt back out — see the `no-drag` rules
 * in app.css. Without that the OS claims the middle of each control and only
 * its padding edges stay clickable.
 *
 * Renders the wordmark alone when nothing is selected, so the strip never
 * collapses or shifts height between the empty and selected states.
 */
export function TitleBar({
  repo,
  worktree
}: {
  repo: Repo | null;
  worktree: Worktree | null;
}) {
  const [switching, setSwitching] = useState(false);

  return (
    <>
      <div className="titlebar">
        {/* macOS-only traffic-light reservation; CSS removes it on Windows. */}
        <div className="titlebar__gutter" />
        <p className="titlebar__brand">
          Pwr<span className="titlebar__brand-accent">Git</span>
        </p>

        {window.pwrgit.platform === "win32" && <AppMenuBar />}

        {repo !== null && worktree !== null && (
          <div className="titlebar__id">
            <span className="titlebar__repo" title={repo.name}>
              {repo.name}
            </span>
            <span aria-hidden="true" className="titlebar__sep">
              ›
            </span>
            <button
              className="titlebar__branch"
              title="Switch branch"
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
              {pathTail(worktree.path)}
            </CopyTarget>
          </div>
        )}

        <div className="titlebar__spacer" />
      </div>

      {/* Sibling of the strip, never inside it: a full-window modal nested in
          a drag region has every pixel claimed by the OS — the search input
          never takes focus, Escape never reaches its handler, and clicking a
          row drags the window instead of switching branches. */}
      {switching && worktree !== null && (
        <BranchSwitcher
          worktreeId={worktree.id}
          currentBranch={worktree.branch}
          onClose={() => setSwitching(false)}
        />
      )}
    </>
  );
}
