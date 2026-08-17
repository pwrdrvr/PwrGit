import { useCallback, useEffect, useState } from "react";
import type { Repo, RepoRefs } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { CopyTarget } from "../shell/CopyTarget";
import {
  localBranchForRemote,
  RepoRefsModal,
  trackingLabel
} from "./RepoRefsModal";

type RefSection = "branches" | "remotes";

function SectionChevron({ open }: { open: boolean }) {
  return <span className={`ref-section__chev${open ? " is-open" : ""}`} />;
}

function compactTrackingLabel(tracking: ReturnType<typeof trackingLabel>): string {
  switch (tracking) {
    case "Up to date":
      return "Synced";
    case "No upstream":
      return "Local only";
    case "Upstream missing":
      return "Missing";
    default:
      return tracking;
  }
}

export function RepoRefsSections({
  repo,
  now,
  onRevealWorktree,
  onCreateWorktree
}: {
  repo: Repo;
  now: number;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktree: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => void;
}) {
  const [refs, setRefs] = useState<RepoRefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<RefSection>>(new Set());
  const [openRemotes, setOpenRemotes] = useState<Set<string>>(new Set());
  const [browser, setBrowser] = useState<RefSection | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await dispatch("repo:refs", { repoId: repo.id });
    setLoading(false);
    if (result.ok) setRefs(result.value);
    else setError(result.error.message.split("\n")[0]);
  }, [repo.id]);

  useEffect(() => {
    void load();
  }, [load, repo]);

  const toggleSection = (section: RefSection): void => {
    setOpenSections((previous) => {
      const next = new Set(previous);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const fetchRemote = async (remote?: string): Promise<void> => {
    setFetching(remote ?? "*");
    const result = await dispatch("remote:fetchRepo", {
      repoId: repo.id,
      ...(remote === undefined ? {} : { remote })
    });
    setFetching(null);
    if (!result.ok) {
      showErrorToast({
        title: "Fetch failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message
      });
      return;
    }
    showInfoToast({
      title: remote === undefined ? "Fetched all remotes" : `Fetched ${remote}`,
      message: "Remote-tracking branches are up to date."
    });
    await load();
  };

  const branchCount = refs?.branches.length;
  const remoteCount = refs?.remotes.length;
  const visibleBranches = refs?.branches.slice(0, 6) ?? [];

  return (
    <>
      <div className="ref-section">
        {/* These are disclosures — they were rendering a rotating caret and no
            `aria-expanded`, so open and closed were indistinguishable to
            anything not looking at the pixels (SC 4.1.2). The Worktrees toggle
            in RepoRow already did this correctly; these two did not. */}
        <button
          className="ref-section__head"
          aria-expanded={openSections.has("branches")}
          onClick={(event) => {
            event.stopPropagation();
            toggleSection("branches");
          }}
        >
          <SectionChevron open={openSections.has("branches")} />
          <span className="ref-section__label">Branches</span>
          <span className="ref-section__count">
            {loading ? "…" : (branchCount ?? 0)}
          </span>
          {refs !== null && (
            <span className="ref-section__summary">
              {refs.branches.filter((branch) => branch.ahead > 0).length > 0 &&
                `↑${refs.branches.filter((branch) => branch.ahead > 0).length}`}
              {refs.branches.filter((branch) => branch.behind > 0).length > 0 &&
                ` ↓${refs.branches.filter((branch) => branch.behind > 0).length}`}
            </span>
          )}
        </button>
        {openSections.has("branches") && (
          <div className="ref-section__body">
            {visibleBranches.map((branch) => (
              <div className="ref-branch-row" key={branch.fullName}>
                <span className="refs-branch-icon" aria-hidden="true">⑂</span>
                <CopyTarget
                  value={branch.name}
                  label={`Copy branch name ${branch.name}`}
                  hint={`${branch.name}\nClick to copy branch name`}
                  className="ref-branch-row__name refs-copyable-name copyable"
                >
                  {/* Wrapped, not bare: the wrapper is a flex box, so the name
                      needs to BE a flex item for `text-overflow` to reach it. */}
                  <span className="refs-copyable-name__text">{branch.name}</span>
                </CopyTarget>
                <span
                  className={`ref-branch-row__status is-${branch.tracking}`}
                  title={trackingLabel(branch)}
                >
                  {compactTrackingLabel(trackingLabel(branch))}
                </span>
                {/* The accessible name of a button comes from its CONTENT
                    before its `title`, so these announced as "●" and "+" —
                    "black circle, button" (SC 4.1.2). An explicit label wins
                    over both, and naming the branch makes the six of them on
                    screen distinguishable from one another. */}
                {branch.checkedOutWorktreeIds.length > 0 ? (
                  <button
                    className="ref-mini-action"
                    aria-label={`Show worktree checked out at ${branch.name}`}
                    title="Show checked-out worktree"
                    onClick={(event) => {
                      event.stopPropagation();
                      const id = branch.checkedOutWorktreeIds[0];
                      if (id !== undefined) onRevealWorktree(id);
                    }}
                  >
                    <span aria-hidden="true">●</span>
                  </button>
                ) : (
                  <button
                    className="ref-mini-action"
                    aria-label={`Create worktree for ${branch.name}`}
                    title="Create worktree"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCreateWorktree(branch.name, false);
                    }}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                )}
              </div>
            ))}
            {error !== null && <div className="ref-section__error">{error}</div>}
            {!loading && refs !== null && refs.branches.length === 0 && (
              <div className="ref-section__empty">No local branches.</div>
            )}
            {refs !== null && refs.branches.length > 0 && (
              <button
                className="ref-view-all"
                onClick={(event) => {
                  event.stopPropagation();
                  setBrowser("branches");
                }}
              >
                View all {refs.branches.length} branches…
              </button>
            )}
          </div>
        )}
      </div>

      <div className="ref-section">
        <div className="ref-section__head-wrap">
          <button
            className="ref-section__head"
            aria-expanded={openSections.has("remotes")}
            onClick={(event) => {
              event.stopPropagation();
              toggleSection("remotes");
            }}
          >
            <SectionChevron open={openSections.has("remotes")} />
            <span className="ref-section__label">Remotes</span>
            <span className="ref-section__count">
              {loading ? "…" : (remoteCount ?? 0)}
            </span>
          </button>
          <button
            className={`ref-fetch-all${fetching === "*" ? " is-fetching" : ""}`}
            aria-label={`Fetch all remotes for ${repo.name}`}
            title="Fetch all remotes and prune deleted branches"
            /* `disabled` stays for the static case (there is nothing to fetch),
               but NOT for the in-flight one: Chromium blurs an element the
               moment it becomes disabled, so a fetch started from the keyboard
               threw focus to <body> until it returned (SC 2.4.3). Busy is
               aria-disabled, which says the same thing and keeps the button
               focusable — same fix as .wt-refresh in RepoRow. */
            disabled={(refs?.remotes.length ?? 0) === 0}
            aria-disabled={fetching !== null || (refs?.remotes.length ?? 0) === 0}
            onClick={(event) => {
              event.stopPropagation();
              if (fetching !== null) return;
              void fetchRemote();
            }}
          >
            ↻
          </button>
        </div>
        {openSections.has("remotes") && (
          <div className="ref-section__body">
            {refs?.remotes.map((remote) => {
              const open = openRemotes.has(remote.name);
              return (
                <div className="ref-remote" key={remote.name}>
                  <div className="ref-remote__row">
                    <button
                      className="ref-remote__main"
                      aria-expanded={open}
                      title={remote.fetchUrl}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenRemotes((previous) => {
                          const next = new Set(previous);
                          if (next.has(remote.name)) next.delete(remote.name);
                          else next.add(remote.name);
                          return next;
                        });
                      }}
                    >
                      <SectionChevron open={open} />
                      <span>{remote.name}</span>
                      <small>
                        {remote.name === "origin"
                          ? "default"
                          : remote.name === "upstream"
                            ? "upstream"
                            : `${remote.branchCount} refs`}
                      </small>
                    </button>
                    <button
                      className={`ref-mini-action${
                        fetching === remote.name ? " is-fetching" : ""
                      }`}
                      aria-label={`Fetch ${remote.name}`}
                      /* Busy, not unavailable — see .ref-fetch-all above. */
                      aria-disabled={fetching !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (fetching !== null) return;
                        void fetchRemote(remote.name);
                      }}
                    >
                      ↻
                    </button>
                  </div>
                  {open && (
                    <div className="ref-remote__branches">
                      {remote.previewBranches.map((branch) => {
                        const local = localBranchForRemote(refs, branch);
                        const checkedOutId = local?.checkedOutWorktreeIds[0];
                        return (
                          <div
                            className="ref-remote-branch-row"
                            key={branch.fullName}
                          >
                            <span className="refs-branch-icon" aria-hidden="true">⑂</span>
                            <CopyTarget
                              value={branch.name}
                              label={`Copy branch name ${branch.name}`}
                              hint={`${branch.qualifiedName}\nClick to copy branch name`}
                              className="refs-copyable-name copyable"
                            >
                              <span className="refs-copyable-name__text">
                                {branch.name}
                              </span>
                            </CopyTarget>
                            {branch.name === remote.defaultBranch && (
                              <small>default</small>
                            )}
                            <button
                              className="ref-mini-action"
                              aria-label={
                                checkedOutId !== undefined
                                  ? `Show worktree checked out at ${branch.name}`
                                  : local !== undefined
                                    ? `Create worktree from local branch ${local.name}`
                                    : `Create a local branch and worktree from ${branch.qualifiedName}`
                              }
                              title={
                                checkedOutId !== undefined
                                  ? "Show checked-out worktree"
                                  : local !== undefined
                                    ? "Create worktree from local branch"
                                    : "Create a local branch in a new worktree"
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                if (checkedOutId !== undefined) {
                                  onRevealWorktree(checkedOutId);
                                } else if (local !== undefined) {
                                  onCreateWorktree(local.name, false);
                                } else {
                                  onCreateWorktree(
                                    branch.name,
                                    true,
                                    branch.fullName
                                  );
                                }
                              }}
                            >
                              <span aria-hidden="true">
                                {checkedOutId === undefined ? "+" : "●"}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                      {remote.branchCount === 0 && (
                        <div className="ref-section__empty">No fetched branches.</div>
                      )}
                      {/* The preview is the newest handful, not the whole
                          remote — say so, rather than letting six rows read as
                          "this remote has six branches". */}
                      {remote.branchCount > remote.previewBranches.length && (
                        <button
                          className="ref-view-all"
                          onClick={(event) => {
                            event.stopPropagation();
                            setBrowser("remotes");
                          }}
                        >
                          View all {remote.branchCount} branches on {remote.name}…
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {error !== null && <div className="ref-section__error">{error}</div>}
            {!loading && refs !== null && refs.remotes.length === 0 && (
              <div className="ref-section__empty">No remotes configured.</div>
            )}
            {refs !== null && (
              <button
                className="ref-view-all"
                onClick={(event) => {
                  event.stopPropagation();
                  setBrowser("remotes");
                }}
              >
                Manage remotes and remote branches…
              </button>
            )}
          </div>
        )}
      </div>

      {browser !== null && refs !== null && (
        <RepoRefsModal
          repo={repo}
          refs={refs}
          now={now}
          initialTab={browser}
          onRefresh={() => void load()}
          onRevealWorktree={onRevealWorktree}
          onCreateWorktree={onCreateWorktree}
          onClose={() => setBrowser(null)}
        />
      )}
    </>
  );
}
