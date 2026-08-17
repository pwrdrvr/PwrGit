import { useEffect, useMemo, useState } from "react";
import type {
  LocalBranchSummary,
  RemoteBranchSummary,
  RemoteSummary,
  Repo,
  RepoRefs
} from "@pwrgit/shared";
import { shortWhen } from "../graph/graph-view";
import { confirmDialog } from "../shell/dialogs";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import {
  useRemoteBranchSearch,
  type RemoteBranchSearch
} from "../../lib/useRemoteBranchSearch";
import { CopyTarget } from "../shell/CopyTarget";
import { PushRefsDialog } from "./PushRefsDialog";
import { RemoteEditorDialog } from "./RemoteEditorDialog";

export function trackingLabel(branch: LocalBranchSummary): string {
  switch (branch.tracking) {
    case "up_to_date":
      return "Up to date";
    case "ahead":
      return `↑${branch.ahead}`;
    case "behind":
      return `↓${branch.behind}`;
    case "diverged":
      return `↑${branch.ahead} ↓${branch.behind}`;
    case "unpublished":
      return "No upstream";
    case "upstream_missing":
      return "Upstream missing";
  }
}

export function localBranchForRemote(
  refs: RepoRefs,
  branch: RemoteBranchSummary
): LocalBranchSummary | undefined {
  return refs.branches.find((candidate) => candidate.name === branch.name);
}

type BrowserBranch =
  | { kind: "local"; branch: LocalBranchSummary }
  | { kind: "remote"; branch: RemoteBranchSummary };

/**
 * "Showing X of Y" plus the control that extends the page.
 *
 * Silent truncation is the failure mode worth designing against here: a list
 * that stops at 50 of 4,466 with no marker reads as the whole remote.
 */
function RefsPageFooter({
  shown,
  total,
  search
}: {
  shown: number;
  total: number;
  search: RemoteBranchSearch;
}) {
  if (search.error !== null) {
    return <div className="refs-page-footer is-error">{search.error}</div>;
  }
  if (search.loading && shown === 0) {
    return <div className="refs-page-footer">Loading branches…</div>;
  }
  if (total === 0) return null;
  return (
    <div className="refs-page-footer">
      <span>
        Showing {shown} of {total}
      </span>
      {search.hasMore && (
        <button
          className="refs-row-action"
          disabled={search.loading}
          onClick={() => search.loadMore()}
        >
          {search.loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

/** One remote's branches, paged rather than listed whole. */
function RemoteBranchList({
  repoId,
  remote,
  query,
  now,
  refs,
  onPick
}: {
  repoId: string;
  remote: string;
  query: string;
  now: number;
  refs: RepoRefs;
  onPick: (branch: RemoteBranchSummary) => void;
}) {
  const search = useRemoteBranchSearch({ repoId, remote, query });
  return (
    <div className="refs-remote-branches">
      {search.rows.map((branch) => {
        const local = localBranchForRemote(refs, branch);
        const checkedOut = (local?.checkedOutWorktreeIds.length ?? 0) > 0;
        return (
          <div className="refs-remote-branch" key={branch.fullName}>
            <span className="refs-branch-icon">⑂</span>
            <div>
              <CopyTarget
                value={branch.name}
                label={`Copy branch name ${branch.name}`}
                hint={`${branch.qualifiedName}\nClick to copy branch name`}
                className="refs-copyable-name copyable"
              >
                <strong>{branch.name}</strong>
              </CopyTarget>
              {branch.subject !== undefined && <small>{branch.subject}</small>}
            </div>
            <span className="refs-table__muted">
              {branch.lastCommitAt === undefined
                ? "—"
                : shortWhen(branch.lastCommitAt, now)}
            </span>
            <button className="refs-row-action" onClick={() => onPick(branch)}>
              {checkedOut ? "Show worktree" : "New worktree"}
            </button>
          </div>
        );
      })}
      {search.total === 0 && !search.loading && (
        <div className="refs-browser__empty">
          No fetched branches match this filter.
        </div>
      )}
      <RefsPageFooter
        shown={search.rows.length}
        total={search.total}
        search={search}
      />
    </div>
  );
}

export function RepoRefsModal({
  repo,
  refs,
  now,
  initialTab,
  onRefresh,
  onRevealWorktree,
  onCreateWorktree,
  onClose
}: {
  repo: Repo;
  refs: RepoRefs;
  now: number;
  initialTab: "branches" | "remotes";
  onRefresh: () => void;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktree: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [query, setQuery] = useState("");
  const [pushOpen, setPushOpen] = useState(false);
  const [remoteEditor, setRemoteEditor] = useState<RemoteSummary | "new" | null>(
    null
  );
  const q = query.trim().toLowerCase();
  // Locals arrive whole on `repo:refs` and are bounded in practice, so they
  // still filter here. Remote branches are not: they page in from main.
  const localMatches = useMemo<BrowserBranch[]>(
    () =>
      refs.branches
        .filter(
          (branch) =>
            q === "" ||
            `${branch.name} ${branch.upstream ?? ""} ${branch.subject ?? ""}`
              .toLowerCase()
              .includes(q)
        )
        .map((branch) => ({ kind: "local" as const, branch })),
    [q, refs.branches]
  );
  const localNames = useMemo(
    () => new Set(refs.branches.map((branch) => branch.name)),
    [refs.branches]
  );
  const remoteSearch = useRemoteBranchSearch({
    repoId: repo.id,
    query,
    enabled: tab === "branches"
  });
  // A remote branch that shadows a local one is still one branch to the user,
  // so it is dropped — per page, since that is the scope we have.
  const remoteMatches = useMemo<BrowserBranch[]>(
    () =>
      remoteSearch.rows
        .filter((branch) => !localNames.has(branch.name))
        .map((branch) => ({ kind: "remote" as const, branch })),
    [localNames, remoteSearch.rows]
  );
  const branches = useMemo(
    () => [...localMatches, ...remoteMatches],
    [localMatches, remoteMatches]
  );
  const branchTabCount =
    refs.branches.length +
    refs.remotes.reduce((total, remote) => total + remote.branchCount, 0);

  const createRemoteWorktree = (branch: RemoteBranchSummary): void => {
    const local = localBranchForRemote(refs, branch);
    const checkedOutId = local?.checkedOutWorktreeIds[0];
    if (checkedOutId !== undefined) onRevealWorktree(checkedOutId);
    else if (local !== undefined) onCreateWorktree(local.name, false);
    else onCreateWorktree(branch.name, true, branch.fullName);
    onClose();
  };

  const removeRemote = async (remote: RemoteSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: `Remove remote ${remote.name}?`,
      message:
        "This removes the remote configuration and its fetched remote-tracking branches. The remote repository itself is not deleted.",
      confirmLabel: "Remove remote",
      danger: true
    });
    if (!confirmed) return;
    const result = await dispatch("remote:remove", {
      repoId: repo.id,
      remote: remote.name
    });
    if (!result.ok) {
      showErrorToast({
        title: "Remove remote failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message
      });
      return;
    }
    onRefresh();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (remoteEditor !== null) setRemoteEditor(null);
      else if (pushOpen) setPushOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pushOpen, remoteEditor]);

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="refs-browser"
        role="dialog"
        aria-label={`${repo.name} branches and remotes`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="refs-browser__head">
          <div>
            <div className="refs-browser__eyebrow">Repository refs</div>
            <div className="refs-browser__title">{repo.name}</div>
          </div>
          <span className="refs-browser__path" title={repo.path}>
            {repo.path}
          </span>
          <button className="refs-icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="refs-browser__toolbar">
          <div className="refs-tabs">
            <button
              className={tab === "branches" ? "is-active" : ""}
              onClick={() => setTab("branches")}
            >
              Branches <span>{branchTabCount}</span>
            </button>
            <button
              className={tab === "remotes" ? "is-active" : ""}
              onClick={() => setTab("remotes")}
            >
              Remotes <span>{refs.remotes.length}</span>
            </button>
          </div>
          <label className="refs-search">
            <span aria-hidden="true">⌕</span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Filter ${tab}…`}
            />
          </label>
          <button className="refs-action" onClick={() => setPushOpen(true)}>
            Push to remotes…
          </button>
          {tab === "remotes" && (
            <button className="refs-action" onClick={() => setRemoteEditor("new")}>
              Add remote…
            </button>
          )}
        </div>

        <div className="refs-browser__body">
          {tab === "branches" && (
            <div className="refs-table">
              <div className="refs-table__header">
                <span>Branch</span>
                <span>Upstream</span>
                <span>Status</span>
                <span>Last commit</span>
                <span />
              </div>
              {branches.map((item) => {
                if (item.kind === "remote") {
                  const branch = item.branch;
                  return (
                    <div className="refs-table__row" key={branch.fullName}>
                      <div className="refs-table__identity">
                        <span className="refs-branch-icon">⑂</span>
                        <div>
                          <CopyTarget
                            value={branch.name}
                            label={`Copy branch name ${branch.name}`}
                            hint={`${branch.qualifiedName}\nClick to copy branch name`}
                            className="refs-copyable-name copyable"
                          >
                            <strong>{branch.name}</strong>
                          </CopyTarget>
                          {branch.subject !== undefined && (
                            <small>{branch.subject}</small>
                          )}
                        </div>
                      </div>
                      <CopyTarget
                        value={branch.qualifiedName}
                        label={`Copy remote branch ${branch.qualifiedName}`}
                        hint={`${branch.qualifiedName}\nClick to copy remote branch`}
                        className="refs-table__muted refs-copyable-upstream copyable"
                      >
                        {branch.qualifiedName}
                      </CopyTarget>
                      <span className="refs-status refs-status--remote">Remote</span>
                      <span className="refs-table__muted">
                        {branch.lastCommitAt === undefined
                          ? "—"
                          : shortWhen(branch.lastCommitAt, now)}
                      </span>
                      <button
                        className="refs-row-action"
                        onClick={() => createRemoteWorktree(branch)}
                      >
                        New worktree
                      </button>
                    </div>
                  );
                }
                const branch = item.branch;
                return (
                  <div className="refs-table__row" key={branch.fullName}>
                    <div className="refs-table__identity">
                      <span className="refs-branch-icon">⑂</span>
                      <div>
                        <CopyTarget
                          value={branch.name}
                          label={`Copy branch name ${branch.name}`}
                          hint={`${branch.name}\nClick to copy branch name`}
                          className="refs-copyable-name copyable"
                        >
                          <strong>{branch.name}</strong>
                        </CopyTarget>
                        {branch.subject !== undefined && (
                          <small>{branch.subject}</small>
                        )}
                      </div>
                    </div>
                    {branch.upstream === undefined ? (
                      <span className="refs-table__muted">—</span>
                    ) : (
                      <CopyTarget
                        value={branch.upstream}
                        label={`Copy upstream branch ${branch.upstream}`}
                        hint={`${branch.upstream}\nClick to copy upstream branch`}
                        className="refs-table__muted refs-copyable-upstream copyable"
                      >
                        {branch.upstream}
                      </CopyTarget>
                    )}
                    <span className={`refs-status refs-status--${branch.tracking}`}>
                      {trackingLabel(branch)}
                    </span>
                    <span className="refs-table__muted">
                      {branch.lastCommitAt === undefined
                        ? "—"
                        : shortWhen(branch.lastCommitAt, now)}
                    </span>
                    {branch.checkedOutWorktreeIds.length > 0 ? (
                      <button
                        className="refs-row-action"
                        onClick={() => {
                          const id = branch.checkedOutWorktreeIds[0];
                          if (id !== undefined) onRevealWorktree(id);
                          onClose();
                        }}
                      >
                        Show worktree
                      </button>
                    ) : (
                      <button
                        className="refs-row-action"
                        onClick={() => {
                          onCreateWorktree(branch.name, false);
                          onClose();
                        }}
                      >
                        New worktree
                      </button>
                    )}
                  </div>
                );
              })}
              {branches.length === 0 && !remoteSearch.loading && (
                <div className="refs-browser__empty">No matching branches.</div>
              )}
              <RefsPageFooter
                shown={branches.length}
                total={localMatches.length + remoteSearch.total}
                search={remoteSearch}
              />
            </div>
          )}

          {tab === "remotes" && (
            <div className="refs-remotes">
              {refs.remotes.map((remote) => (
                <section className="refs-remote-card" key={remote.name}>
                  <div className="refs-remote-card__head">
                    <div>
                      <strong>{remote.name}</strong>
                      <span className="refs-remote-role">
                        {remote.name === "origin"
                          ? "Default"
                          : remote.name === "upstream"
                            ? "Upstream"
                            : "Remote"}
                      </span>
                    </div>
                    <div className="refs-remote-card__actions">
                      <span>{remote.branchCount} branches</span>
                      <button onClick={() => setRemoteEditor(remote)}>Edit</button>
                      <button
                        className="is-danger"
                        onClick={() => void removeRemote(remote)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <div className="refs-remote-card__urls">
                    <span>Fetch</span>
                    <code>{remote.fetchUrl}</code>
                    <span>Push</span>
                    <code>{remote.pushUrl}</code>
                    <span>Default</span>
                    <code>{remote.defaultBranch ?? "Unknown"}</code>
                  </div>
                  <RemoteBranchList
                    repoId={repo.id}
                    remote={remote.name}
                    query={query}
                    now={now}
                    refs={refs}
                    onPick={createRemoteWorktree}
                  />
                </section>
              ))}
              {refs.remotes.length === 0 && (
                <div className="refs-browser__empty">No remotes configured.</div>
              )}
            </div>
          )}
        </div>

        {pushOpen && (
          <PushRefsDialog
            repo={repo}
            refs={refs}
            onCompleted={onRefresh}
            onClose={() => setPushOpen(false)}
          />
        )}
        {remoteEditor !== null && (
          <RemoteEditorDialog
            repo={repo}
            {...(remoteEditor === "new" ? {} : { remote: remoteEditor })}
            onSaved={onRefresh}
            onClose={() => setRemoteEditor(null)}
          />
        )}
      </div>
    </div>
  );
}
