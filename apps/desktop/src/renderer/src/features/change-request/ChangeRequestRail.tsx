import { useState, type ReactElement } from "react";
import { fileStatusChipProps } from "../../lib/fileStatus";
import {
  hoverTooltip,
  truncatedTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import type { DiffFileStatus } from "../diff/parse-diff";
import { shortWhen } from "../graph/graph-view";
import type { ChangeRequestViewState } from "./useChangeRequestView";

const STATUS_LETTER: Record<DiffFileStatus, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R"
};

/**
 * The rail while a change request is on screen: its table of contents.
 * Changes lists the files of what the main pane draws (all of it, or one
 * commit) and brings a file into view; Commits picks that scope. The same
 * place the Changes tab lists a clicked commit's files for a worktree.
 *
 * Design: `design/Change Request View - UX Review.dc.html`, 2a and 3c.
 */
export function ChangeRequestRail({
  state,
  now,
  onFocusFile,
  onCollapse
}: {
  state: ChangeRequestViewState;
  now: number;
  onFocusFile: (path: string) => void;
  onCollapse: () => void;
}): ReactElement {
  const tip = useViewportTooltip();
  const [tab, setTab] = useState<"changes" | "commits">("changes");
  const { view, scope, setScope, files, patch } = state;
  const ready = view?.state === "ready" ? view : null;
  const commits = ready?.commits ?? [];

  return (
    <aside className="pane pane--rail cr-rail" data-testid="rail">
      <div className="rail__bar">
        <button
          className={`rail-tab${tab === "changes" ? " is-active" : ""}`}
          onClick={() => setTab("changes")}
        >
          <span className="rail-tab__label">Changes</span>
          {files.length > 0 && (
            <span className="rail-tab__badge rail-tab__badge--count">{files.length}</span>
          )}
        </button>
        <button
          className={`rail-tab${tab === "commits" ? " is-active" : ""}`}
          onClick={() => setTab("commits")}
        >
          <span className="rail-tab__label">Commits</span>
          {commits.length > 0 && (
            <span className="rail-tab__badge rail-tab__badge--count">
              {ready?.commitsTruncated === true ? `${commits.length}+` : commits.length}
            </span>
          )}
        </button>
        <button
          className="icon-btn rail__collapse"
          onClick={onCollapse}
          {...hoverTooltip(tip, "Collapse panel")}
          aria-label="Collapse panel"
        >
          ›
        </button>
      </div>

      {tab === "changes" ? (
        <div className="changes-pane">
          <div className="changes-list">
            <div className="changes-section">
              <span className="changes-section__label">
                {scope.kind === "all" ? "All changes" : `Commit ${scope.hash.slice(0, 7)}`}
                {patch !== null && ` · ${files.length} ${files.length === 1 ? "file" : "files"}`}
              </span>
            </div>
            {ready !== null && scope.kind === "all" && ready.patch === null ? (
              <div className="cr-rail__note">Too large to list here. Pick a commit.</div>
            ) : state.scopeError !== null ? (
              <div className="cr-rail__note">Couldn’t read this commit’s diff.</div>
            ) : patch === null ? (
              <div className="cr-rail__note">Loading…</div>
            ) : (
              files.map((file) => {
                const letter = STATUS_LETTER[file.status];
                return (
                  <button
                    key={file.path}
                    className="cr-rail__item cr-rail__file"
                    onClick={() => onFocusFile(file.path)}
                    {...hoverTooltip(tip, file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`)}
                  >
                    <span {...fileStatusChipProps(letter)}>{letter}</span>
                    <span className="cr-rail__path">{file.path}</span>
                    {!file.binary && (
                      <span className="cr-rail__stat">
                        {file.additions > 0 && <span className="cr-view__add">+{file.additions}</span>}
                        {file.deletions > 0 && <span className="cr-view__del">−{file.deletions}</span>}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div className="changes-pane">
          <div className="changes-list">
            <button
              className={`cr-rail__item${scope.kind === "all" ? " is-selected" : ""}`}
              aria-pressed={scope.kind === "all"}
              onClick={() => setScope({ kind: "all" })}
            >
              <span className="cr-rail__subject">All changes</span>
              {ready !== null && (
                <span className="cr-rail__hash">
                  {commits.length}
                  {ready.commitsTruncated ? "+" : ""} {commits.length === 1 ? "commit" : "commits"}
                </span>
              )}
            </button>
            {commits.map((commit) => {
              const on = scope.kind === "commit" && scope.hash === commit.hash;
              return (
                <button
                  key={commit.hash}
                  className={`cr-rail__item${on ? " is-selected" : ""}`}
                  aria-pressed={on}
                  onClick={() =>
                    setScope({ kind: "commit", hash: commit.hash, subject: commit.subject })
                  }
                >
                  <span className="cr-rail__subject" {...truncatedTooltip(tip, commit.subject)}>
                    {commit.subject}
                  </span>
                  <span className="cr-rail__hash">{commit.hash.slice(0, 7)}</span>
                  <span className="cr-rail__age">
                    {shortWhen(new Date(commit.at).toISOString(), now).split(" ")[0]}
                  </span>
                </button>
              );
            })}
            {ready?.commitsTruncated === true && (
              <div className="cr-rail__note">Only the newest {commits.length} are listed.</div>
            )}
          </div>
          {ready !== null && (
            <div className="cr-rail__base">
              <span className="cr-rail__base-label">Base</span>
              <span className="cr-rail__base-ref">
                {ready.base.name} · merge base {ready.base.mergeBase.slice(0, 7)}
              </span>
            </div>
          )}
        </div>
      )}
      {tip.tooltipNode}
    </aside>
  );
}
