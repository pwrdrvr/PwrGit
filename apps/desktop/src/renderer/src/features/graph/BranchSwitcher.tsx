import { useEffect, useMemo, useRef, useState } from "react";
import type { BranchRef, TrackingChoices, TrackingOption, WorktreeId } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useRelativeClock } from "../../lib/useRelativeClock";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { CheckGlyph } from "../../lib/CheckGlyph";
import { showInfoToast } from "../../lib/toast";
import { guardedSwitchBranch } from "../shell/branchSwitch";
import { shortWhen } from "./graph-view";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { remoteBranchName, switchTarget, switcherRows, type SwitcherRow } from "./branch-switcher-model";
import { RetrackReview, type RetrackDone } from "./RetrackReview";

/** A remote ref the user has chosen for a row, not yet confirmed. */
type Pick = { remote: string; remoteBranch: string; ref: string };

const pickOf = (ref: BranchRef): Pick => ({
  remote: ref.remote ?? ref.name.split("/")[0] ?? ref.name,
  remoteBranch: remoteBranchName(ref),
  ref: ref.name
});

/** The menu's relation column, in Reset to Remote's words. */
export function relationLabel(option: TrackingOption): { text: string; tone: "" | "ff" | "dv" } {
  if (option.ahead === 0 && option.behind === 0) return { text: "same commit", tone: "" };
  if (option.ahead === 0) return { text: `↓${option.behind} fast-forward`, tone: "ff" };
  if (option.behind === 0) return { text: `↑${option.ahead} you're ahead`, tone: "" };
  return { text: `↑${option.ahead} ↓${option.behind} diverged`, tone: "dv" };
}

/** The count beside a changed chip: what choosing it would do to the tip. */
function pickHint(option: TrackingOption | undefined): string {
  if (option === undefined) return "";
  if (option.ahead === 0) return option.behind === 0 ? "" : `↓${option.behind}`;
  return option.behind === 0 ? `↑${option.ahead}` : `↑${option.ahead} ↓${option.behind}`;
}

/**
 * Pick the branch a worktree checks out, or another remote for a branch to
 * track. Lists local heads and remote-only branches, current first. A remote
 * branch with a local namesake is not a row: it is one of that row's tracking
 * choices, behind the chip's caret (`branch-switcher-model.ts`). Choosing one
 * opens the review step in place of the list (`RetrackReview`); nothing moves
 * until it is confirmed there.
 *
 * Selecting a row goes through `guardedSwitchBranch`; the tree, header, and
 * graph refresh off the resulting events. This overlay used to dispatch
 * `branch:switch` itself, and so was the one switch entry point with no dirty
 * guard. It also rendered git's raw "already used by worktree at …" into the
 * footer where every other surface takes you to that worktree.
 * Design: `design/Tracking Another Remote - UX Review.dc.html`.
 */
export function BranchSwitcher({
  worktreeId,
  worktreeLabel,
  currentBranch,
  onHeldElsewhere,
  onClose
}: {
  worktreeId: string;
  /** How the dirty confirm names this checkout — its folder, not its branch. */
  worktreeLabel: string;
  currentBranch: string;
  /** Another worktree holds the picked branch. Navigating there is the caller's
   *  job; the overlay only knows it should get out of the way. */
  onHeldElsewhere: (branch: string) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const now = useRelativeClock();
  const [branches, setBranches] = useState<BranchRef[] | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Per local branch: the remote chosen in its chip. `null` is an explicit
   *  "keep what it tracks", which outranks a search's pick. */
  const [picked, setPicked] = useState<Record<string, Pick | null>>({});
  const [choices, setChoices] = useState<Record<string, TrackingChoices | "loading">>({});
  /** The open remote menu. Its highlight is the ref, not a position: the
   *  list re-sorts and can grow when the options arrive. */
  const [menu, setMenu] = useState<{ branch: string; ref: string | null; left: number; top: number } | null>(null);
  const [review, setReview] = useState<{ branch: string; pick: Pick } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    inputRef.current?.focus();
    let active = true;
    void dispatch("branch:list", { worktreeId }).then((r) => {
      if (active && r.ok) setBranches(r.value);
    });
    return () => {
      active = false;
    };
  }, [worktreeId]);

  const rows = useMemo<SwitcherRow[]>(
    () => switcherRows(branches ?? [], query),
    [branches, query]
  );

  useEffect(() => {
    setSel(0);
    setMenu(null);
  }, [query]);

  const pickFor = (row: SwitcherRow): Pick | null => {
    const own = picked[row.ref.name];
    if (own !== undefined) return own;
    return row.searchPick === null ? null : pickOf(row.searchPick);
  };

  const loadChoices = (branch: string): void => {
    if (choices[branch] !== undefined) return;
    setChoices((c) => ({ ...c, [branch]: "loading" }));
    void dispatch("remote:trackingOptions", { worktreeId, branch }).then((r) => {
      setChoices((c) => {
        const next = { ...c };
        if (r.ok) next[branch] = r.value;
        else delete next[branch];
        return next;
      });
    });
  };

  // A search that landed on another remote's copy shows its count at once.
  useEffect(() => {
    for (const row of rows) if (row.searchPick !== null) loadChoices(row.ref.name);
    // loadChoices skips a branch already loading or loaded, so only rows matter.
  }, [rows]);

  /** The menu's rows: what the branch tracks, then every other remote's copy.
   *  Until the options arrive, the names alone from the branch list. */
  const menuOptions = (row: SwitcherRow): { pick: Pick; option?: TrackingOption; tracked: boolean }[] => {
    const loaded = choices[row.ref.name];
    if (loaded !== undefined && loaded !== "loading") {
      return loaded.options.map((option) => ({
        pick: { remote: option.remote, remoteBranch: option.remoteBranch, ref: option.ref },
        option,
        tracked: option.tracked
      }));
    }
    // The upstream's own remote ref, so a remote with a slash and an upstream
    // under another name both read right; the bare name only if it isn't listed.
    const upstreamRef =
      row.ref.upstream === undefined
        ? undefined
        : (branches ?? []).find((b) => b.isRemote && b.name === row.ref.upstream);
    const upstream =
      row.ref.upstream === undefined
        ? []
        : [{
            pick: upstreamRef !== undefined
              ? pickOf(upstreamRef)
              : { remote: row.ref.upstream.split("/")[0] ?? "", remoteBranch: row.ref.upstream.replace(/^[^/]+\//, ""), ref: row.ref.upstream },
            tracked: true
          }];
    return [...upstream, ...row.alternates.map((alt) => ({ pick: pickOf(alt), tracked: false }))];
  };

  const openMenu = (row: SwitcherRow): void => {
    const caret = caretRefs.current.get(row.ref.name);
    if (caret === undefined) return;
    // Under the chip, left-aligned with it, as the design draws it; pulled
    // in from the window's right edge when the chip sits far right.
    const rect = (caret.closest(".branch-track") ?? caret).getBoundingClientRect();
    loadChoices(row.ref.name);
    const options = menuOptions(row);
    const chosen = pickFor(row);
    const at = chosen?.ref ?? options.find((o) => o.tracked)?.pick.ref ?? options[0]?.pick.ref ?? null;
    setMenu({ branch: row.ref.name, ref: at, left: Math.max(12, Math.min(rect.left, window.innerWidth - 352)), top: rect.bottom + 6 });
  };

  /** A menu choice: the tracked ref clears the row's pick; any other opens
   *  the review, which moves nothing until it is confirmed. */
  const choose = (row: SwitcherRow, choice: { pick: Pick; tracked: boolean }): void => {
    setMenu(null);
    if (choice.tracked) {
      setPicked((p) => ({ ...p, [row.ref.name]: null }));
      return;
    }
    setPicked((p) => ({ ...p, [row.ref.name]: choice.pick }));
    setReview({ branch: row.ref.name, pick: choice.pick });
  };

  const switchTo = async (target: string): Promise<boolean> => {
    setBusy(target);
    setError(null);
    const outcome = await guardedSwitchBranch({
      worktreeId: worktreeId as WorktreeId,
      worktreeLabel,
      fromBranch: currentBranch,
      branch: target
    });
    setBusy(null);
    if (outcome.kind === "switched") {
      onClose();
    } else if (outcome.kind === "held") {
      onClose();
      onHeldElsewhere(target);
    } else if (outcome.kind === "failed") {
      setError(outcome.message.split("\n")[0] ?? outcome.message);
    }
    // "cancelled" means the dirty confirm was declined — the picker stays open
    // so the reader can choose differently rather than starting over.
    return outcome.kind === "switched";
  };

  const activate = async (row: SwitcherRow): Promise<void> => {
    const chosen = pickFor(row);
    if (chosen !== null) {
      setReview({ branch: row.ref.name, pick: chosen });
      return;
    }
    const ref = row.ref;
    // The list is live git truth; currentBranch is what the app is showing.
    // When they agree, picking the current branch is a no-op. When they
    // DISAGREE (the checkout moved externally and our label is stale), fall
    // through — the switch is a git no-op but its refresh chain reconciles
    // the header, sidebar, and graph with reality.
    if (ref.isCurrent && ref.name === currentBranch) {
      onClose();
      return;
    }
    await switchTo(switchTarget(ref));
  };

  const retracked = async (done: RetrackDone, isCurrent: boolean): Promise<void> => {
    const moved = done.copied !== null
      ? `Its old tip is on ${done.copied}.`
      : done.move === "forward" && done.arrived > 0
        ? `Fast-forwarded ${done.arrived} ${done.arrived === 1 ? "commit" : "commits"}.`
        : done.move !== "none"
          ? `${done.branch} now matches ${done.ref}.`
          : "Only its tracking changed.";
    showInfoToast({ title: `${done.branch} tracks ${done.ref}`, message: moved });
    setReview(null);
    // The list still shows the old upstream; if the switch below is declined
    // the picker stays open, and must not offer the same change again.
    void dispatch("branch:list", { worktreeId }).then((r) => {
      if (r.ok) setBranches(r.value);
    });
    setPicked((p) => ({ ...p, [done.branch]: null }));
    setChoices((c) => {
      const next = { ...c };
      delete next[done.branch];
      return next;
    });
    if (isCurrent) {
      onClose();
      return;
    }
    await switchTo(done.branch);
  };

  if (review !== null) {
    const row = rows.find((r) => r.ref.name === review.branch);
    return (
      <div className="overlay-backdrop" onClick={onClose}>
        <div
          className="overlay-panel retrack"
          // Holds focus while the review is up, so Esc reaches it: the
          // search field that had focus is gone with the list.
          tabIndex={-1}
          ref={(el) => {
            if (el !== null && !el.contains(document.activeElement)) el.focus();
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setReview(null);
              requestAnimationFrame(() => inputRef.current?.focus());
            }
          }}
        >
          <RetrackReview
            worktreeId={worktreeId}
            branch={review.branch}
            remote={review.pick.remote}
            remoteBranch={review.pick.remoteBranch}
            onBack={() => {
              setReview(null);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            onDone={(done) => void retracked(done, row?.ref.isCurrent ?? false)}
          />
        </div>
      </div>
    );
  }

  const selected = rows[sel];
  const menuRow = menu === null ? undefined : rows.find((r) => r.ref.name === menu.branch);
  const menuList = menuRow === undefined ? [] : menuOptions(menuRow);
  const menuSel = Math.max(0, menuList.findIndex((c) => c.pick.ref === menu?.ref));
  const highlight = (i: number): void => {
    const next = menuList[i];
    if (menu !== null && next !== undefined) setMenu({ ...menu, ref: next.pick.ref });
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="overlay-panel"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(null);
        }}
      >
        <div className="overlay-search">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Switch from ${currentBranch}…`}
            role="combobox"
            aria-expanded={menu !== null}
            aria-controls="branch-switcher-list"
            onKeyDown={(e) => {
              if (menu !== null && menuRow !== undefined) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  highlight(Math.min(menuSel + 1, menuList.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  highlight(Math.max(menuSel - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const choice = menuList[menuSel];
                  if (choice !== undefined) choose(menuRow, choice);
                } else if (e.key === "ArrowLeft" || e.key === "Escape") {
                  e.preventDefault();
                  setMenu(null);
                }
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (
                e.key === "ArrowRight" &&
                selected !== undefined &&
                selected.alternates.length > 0 &&
                e.currentTarget.selectionStart === query.length
              ) {
                e.preventDefault();
                openMenu(selected);
              } else if (e.key === "Enter") {
                if (selected !== undefined && busy === null) void activate(selected);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <div className="overlay-results" role="listbox" id="branch-switcher-list" aria-label="Branches">
          {rows.map((row, i) => {
            const b = row.ref;
            const chosen = pickFor(row);
            const loaded = choices[b.name];
            const chosenOption =
              chosen === null || loaded === undefined || loaded === "loading"
                ? undefined
                : loaded.options.find((o) => o.ref === chosen.ref);
            const open = menu?.branch === b.name;
            return (
              <div
                key={b.name}
                role="option"
                aria-selected={i === sel}
                aria-disabled={busy !== null}
                className={`overlay-result branch-item${i === sel ? " is-selected" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  if (busy === null) void activate(row);
                }}
              >
                <span className={`branch-item__dot${b.isCurrent ? " is-current" : ""}`} />
                <span
                  className="branch-item__name"
                  {...hoverTooltip(
                    tip,
                    !b.isRemote && b.upstream ? `${b.name} · tracks ${b.upstream}` : b.name
                  )}
                >
                  {b.name}
                  {row.alternates.length === 0 && !b.isRemote && b.upstream && (
                    <span className="branch-item__meta"> · tracks {b.upstream}</span>
                  )}
                </span>
                {row.alternates.length > 0 && (
                  <span
                    className={`branch-track${chosen !== null ? " is-changed" : ""}${open ? " is-open" : ""}`}
                  >
                    <span className="branch-track__value">
                      {chosen !== null ? "track " : b.upstream !== undefined ? "tracks " : ""}
                      <b>{chosen?.ref ?? b.upstream ?? "no upstream"}</b>
                    </span>
                    <button
                      type="button"
                      tabIndex={-1}
                      ref={(el) => {
                        if (el === null) caretRefs.current.delete(b.name);
                        else caretRefs.current.set(b.name, el);
                      }}
                      className="branch-track__caret"
                      aria-label={`Track another remote for ${b.name}`}
                      aria-haspopup="listbox"
                      aria-expanded={open}
                      {...hoverTooltip(tip, "Track another remote (→)")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel(i);
                        if (open) setMenu(null);
                        else openMenu(row);
                      }}
                    >
                      <ChevronGlyph size={9} up={open} />
                    </button>
                  </span>
                )}
                {chosen !== null && pickHint(chosenOption) !== "" && (
                  <span className="branch-track__hint">{pickHint(chosenOption)}</span>
                )}
                <span className="branch-item__grow" />
                {b.isCurrent && <span className="branch-item__here">current</span>}
                {b.isRemote && <span className="branch-item__badge">remote</span>}
                {busy === switchTarget(b) && <span className="branch-item__meta">switching…</span>}
                {busy !== switchTarget(b) && b.lastCommitAt !== undefined && (
                  <span className="branch-item__meta">{shortWhen(b.lastCommitAt, now)}</span>
                )}
              </div>
            );
          })}
          {branches !== null && rows.length === 0 && (
            <div className="overlay-empty">
              {query.trim() === "" ? "No branches" : `No branches match "${query}"`}
            </div>
          )}
          {branches === null && <div className="overlay-empty">Loading…</div>}
        </div>

        {menu !== null && menuRow !== undefined && (
          <div
            className="branch-track-menu"
            role="listbox"
            aria-label={`${menuRow.ref.name} tracks`}
            style={{ left: menu.left, top: menu.top }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="branch-track-menu__head">{menuRow.ref.name} tracks</div>
            {menuList.map((choice, i) => {
              const relation = choice.option === undefined ? null : relationLabel(choice.option);
              const repo = choice.option?.nameWithOwner;
              const cantPush = choice.option?.canPush === false;
              return (
                <div
                  key={choice.pick.ref}
                  role="option"
                  aria-selected={i === menuSel}
                  className={`branch-track-menu__item${i === menuSel ? " is-selected" : ""}`}
                  onMouseEnter={() => highlight(i)}
                  onClick={() => choose(menuRow, choice)}
                >
                  <span className="branch-track-menu__check">
                    {choice.tracked && <CheckGlyph size={12} />}
                  </span>
                  <span className="branch-track-menu__name">
                    {choice.pick.remote}
                    {(repo !== undefined || cantPush) && (
                      <small>
                        {[repo, cantPush ? "you can't push" : undefined].filter(Boolean).join(" · ")}
                      </small>
                    )}
                  </span>
                  <span className={`branch-track-menu__rel${relation?.tone ? ` is-${relation.tone}` : ""}`}>
                    {relation?.text ?? "…"}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {error !== null ? (
          <div className="overlay-foot overlay-foot--error">{error}</div>
        ) : menu !== null ? (
          <div className="overlay-foot">
            <span>↑↓ remote</span>
            <span>↵ review</span>
            <span>← back</span>
            <span style={{ flex: 1 }} />
            <span>
              {rows.length} {rows.length === 1 ? "branch" : "branches"}
            </span>
          </div>
        ) : (
          <div className="overlay-foot">
            <span>↑↓ navigate</span>
            <span>
              {selected !== undefined && pickFor(selected) !== null ? "↵ review tracking change" : "↵ switch"}
            </span>
            {selected !== undefined && selected.alternates.length > 0 && <span>→ other remotes</span>}
            <span style={{ flex: 1 }} />
            <span>
              {rows.length} {rows.length === 1 ? "branch" : "branches"}
            </span>
          </div>
        )}
      </div>
      {tip.tooltipNode}
    </div>
  );
}
