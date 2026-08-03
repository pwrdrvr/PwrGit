import { useMemo, useState } from "react";
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
  const branches = useMemo(
    () =>
      q === ""
        ? refs.branches
        : refs.branches.filter((branch) =>
            `${branch.name} ${branch.upstream ?? ""} ${branch.subject ?? ""}`
              .toLowerCase()
              .includes(q)
          ),
    [q, refs.branches]
  );
  const remotes = useMemo(
    () =>
      refs.remotes
        .map((remote) => ({
          ...remote,
          branches:
            q === ""
              ? remote.branches
              : remote.branches.filter((branch) =>
                  `${branch.qualifiedName} ${branch.subject ?? ""}`
                    .toLowerCase()
                    .includes(q)
                )
        }))
        .filter(
          (remote) =>
            q === "" ||
            remote.name.toLowerCase().includes(q) ||
            remote.fetchUrl.toLowerCase().includes(q) ||
            remote.branches.length > 0
        ),
    [q, refs.remotes]
  );

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
              Branches <span>{refs.branches.length}</span>
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
              {branches.map((branch) => (
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
                      {branch.subject !== undefined && <small>{branch.subject}</small>}
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
              ))}
              {branches.length === 0 && (
                <div className="refs-browser__empty">No matching local branches.</div>
              )}
            </div>
          )}

          {tab === "remotes" && (
            <div className="refs-remotes">
              {remotes.map((remote) => (
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
                      <span>{remote.branches.length} branches</span>
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
                  <div className="refs-remote-branches">
                    {remote.branches.map((branch) => {
                      const local = localBranchForRemote(refs, branch);
                      const checkedOut =
                        (local?.checkedOutWorktreeIds.length ?? 0) > 0;
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
                            {branch.subject !== undefined && (
                              <small>{branch.subject}</small>
                            )}
                          </div>
                          <span className="refs-table__muted">
                            {branch.lastCommitAt === undefined
                              ? "—"
                              : shortWhen(branch.lastCommitAt, now)}
                          </span>
                          <button
                            className="refs-row-action"
                            onClick={() => createRemoteWorktree(branch)}
                          >
                            {checkedOut ? "Show worktree" : "New worktree"}
                          </button>
                        </div>
                      );
                    })}
                    {remote.branches.length === 0 && (
                      <div className="refs-browser__empty">
                        No fetched branches match this filter.
                      </div>
                    )}
                  </div>
                </section>
              ))}
              {remotes.length === 0 && (
                <div className="refs-browser__empty">No matching remotes.</div>
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
