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
        <button
          className="ref-section__head"
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
                <span className="refs-branch-icon">⑂</span>
                <CopyTarget
                  value={branch.name}
                  label={`Copy branch name ${branch.name}`}
                  hint={`${branch.name}\nClick to copy branch name`}
                  className="ref-branch-row__name refs-copyable-name copyable"
                >
                  {branch.name}
                </CopyTarget>
                <span
                  className={`ref-branch-row__status is-${branch.tracking}`}
                  title={trackingLabel(branch)}
                >
                  {compactTrackingLabel(trackingLabel(branch))}
                </span>
                {branch.checkedOutWorktreeIds.length > 0 ? (
                  <button
                    className="ref-mini-action"
                    title="Show checked-out worktree"
                    onClick={(event) => {
                      event.stopPropagation();
                      const id = branch.checkedOutWorktreeIds[0];
                      if (id !== undefined) onRevealWorktree(id);
                    }}
                  >
                    ●
                  </button>
                ) : (
                  <button
                    className="ref-mini-action"
                    title="Create worktree"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCreateWorktree(branch.name, false);
                    }}
                  >
                    +
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
            disabled={fetching !== null || (refs?.remotes.length ?? 0) === 0}
            onClick={(event) => {
              event.stopPropagation();
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
                            : `${remote.branches.length} refs`}
                      </small>
                    </button>
                    <button
                      className={`ref-mini-action${
                        fetching === remote.name ? " is-fetching" : ""
                      }`}
                      aria-label={`Fetch ${remote.name}`}
                      disabled={fetching !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        void fetchRemote(remote.name);
                      }}
                    >
                      ↻
                    </button>
                  </div>
                  {open && (
                    <div className="ref-remote__branches">
                      {remote.branches.slice(0, 6).map((branch) => {
                        const local = localBranchForRemote(refs, branch);
                        const checkedOutId = local?.checkedOutWorktreeIds[0];
                        return (
                          <div
                            className="ref-remote-branch-row"
                            key={branch.fullName}
                          >
                            <span className="refs-branch-icon">⑂</span>
                            <CopyTarget
                              value={branch.name}
                              label={`Copy branch name ${branch.name}`}
                              hint={`${branch.qualifiedName}\nClick to copy branch name`}
                              className="refs-copyable-name copyable"
                            >
                              {branch.name}
                            </CopyTarget>
                            {branch.name === remote.defaultBranch && (
                              <small>default</small>
                            )}
                            <button
                              className="ref-mini-action"
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
                              {checkedOutId === undefined ? "+" : "●"}
                            </button>
                          </div>
                        );
                      })}
                      {remote.branches.length === 0 && (
                        <div className="ref-section__empty">No fetched branches.</div>
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
            {refs !== null && refs.remotes.length > 0 && (
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
