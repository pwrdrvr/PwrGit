import { useEffect, useMemo, useState } from "react";
import type {
  LocalBranchSummary,
  RemoteBranchSummary,
  RemoteSummary,
  Repo,
  RepoRefs,
  TagSummary
} from "@pwrgit/shared";
import { shortWhen } from "../graph/graph-view";
import { confirmDialog } from "../shell/dialogs";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { useTagSearch } from "../../lib/useTagSearch";
import {
  useRemoteBranchSearch,
  type RemoteBranchSearch
} from "../../lib/useRemoteBranchSearch";
import { CopyTarget } from "../shell/CopyTarget";
import { BranchRenameDialog } from "./BranchRenameDialog";
import { PushRefsDialog } from "./PushRefsDialog";
import { CreateTagDialog } from "./CreateTagDialog";
import { RemoteEditorDialog } from "./RemoteEditorDialog";
import { TagRemoteDialog } from "./TagRemoteDialog";

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
  search,
  noun = "branches"
}: {
  shown: number;
  total: number;
  search: Pick<
    RemoteBranchSearch,
    "error" | "loading" | "hasMore" | "loadMore"
  >;
  noun?: string;
}) {
  if (search.error !== null) {
    return <div className="refs-page-footer is-error">{search.error}</div>;
  }
  if (search.loading && shown === 0) {
    return <div className="refs-page-footer">Loading {noun}…</div>;
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
  initialTab: "branches" | "tags" | "remotes";
  onRefresh: () => void | Promise<void>;
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
  const [createTagOpen, setCreateTagOpen] = useState(false);
  const [remoteTag, setRemoteTag] = useState<TagSummary | null>(null);
  const [tagEpoch, setTagEpoch] = useState(0);
  const [remoteEditor, setRemoteEditor] = useState<RemoteSummary | "new" | null>(
    null
  );
  const [renaming, setRenaming] = useState<LocalBranchSummary | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
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
  const tagSearch = useTagSearch({
    repoId: repo.id,
    query,
    enabled: tab === "tags",
    refreshKey: tagEpoch
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

  const tagsChanged = (): void => {
    setTagEpoch((value) => value + 1);
    onRefresh();
  };

  const deleteLocalTag = async (tag: TagSummary): Promise<void> => {
    if (deletingTag !== null) return;
    const confirmed = await confirmDialog({
      title: `Delete local tag ${tag.name}?`,
      message: `This deletes only local ${tag.fullName} at ${tag.objectId.slice(0, 12)}. Tags on remotes are unchanged.`,
      confirmLabel: "Delete local tag",
      danger: true
    });
    if (!confirmed) return;
    setDeletingTag(tag.name);
    const result = await dispatch("tag:deleteLocal", {
      repoId: repo.id,
      name: tag.name,
      expectedObjectId: tag.objectId
    });
    setDeletingTag(null);
    if (!result.ok) {
      showErrorToast({
        title: "Delete tag failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message
      });
      return;
    }
    tagsChanged();
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

  const reportDeleteFailure = async (
    branch: LocalBranchSummary,
    message: string
  ): Promise<void> => {
    showErrorToast({
      title: "Delete branch failed",
      message: message.split("\n")[0] ?? message,
      detail: message
    });
    // Occupancy and expected-tip failures mean the browser snapshot is stale.
    // Refresh on every failure: it is cheap for locals and avoids special-case
    // drift between the action labels and main's live Git view.
    await onRefresh();
  };

  const deleteBranch = async (branch: LocalBranchSummary): Promise<void> => {
    if (deleting !== null) return;
    const confirmed = await confirmDialog({
      title: `Delete local branch ${branch.name}?`,
      message:
        "Git will delete this local branch only if its commits are merged into its upstream (or the current history when it has no upstream). No remote branch is changed.",
      confirmLabel: "Delete branch",
      danger: true
    });
    if (!confirmed) return;

    setDeleting(branch.name);
    const result = await dispatch("branch:delete", {
      repoId: repo.id,
      branch: branch.name,
      expectedHead: branch.head
    });
    setDeleting(null);
    if (result.ok) {
      showInfoToast({
        title: "Branch deleted",
        message: `${branch.name} was deleted locally. No remote branch was changed.`
      });
      await onRefresh();
      return;
    }
    if (result.error.code !== "unmerged") {
      await reportDeleteFailure(branch, result.error.message);
      return;
    }

    const forced = await confirmDialog({
      title: `Force delete ${branch.name}?`,
      message:
        "Git cannot confirm that this branch's commits are merged. Force deletion can make commits unique to this local branch difficult to recover.\n\nOnly the local branch is deleted. No remote branch is changed.",
      confirmLabel: "Force delete branch",
      danger: true
    });
    if (!forced) return;

    setDeleting(branch.name);
    const forcedResult = await dispatch("branch:delete", {
      repoId: repo.id,
      branch: branch.name,
      expectedHead: branch.head,
      force: true
    });
    setDeleting(null);
    if (!forcedResult.ok) {
      await reportDeleteFailure(branch, forcedResult.error.message);
      return;
    }
    showInfoToast({
      title: "Branch force-deleted",
      message: `${branch.name} was deleted locally. No remote branch was changed.`
    });
    await onRefresh();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (renaming !== null) setRenaming(null);
      else if (remoteTag !== null) setRemoteTag(null);
      else if (createTagOpen) setCreateTagOpen(false);
      else if (remoteEditor !== null) setRemoteEditor(null);
      else if (pushOpen) setPushOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createTagOpen, onClose, pushOpen, remoteEditor, remoteTag, renaming]);

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="refs-browser"
        role="dialog"
        aria-label={`${repo.name} branches, tags, and remotes`}
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
              className={tab === "tags" ? "is-active" : ""}
              onClick={() => setTab("tags")}
            >
              Tags <span>{refs.tagCount}</span>
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
          {tab !== "tags" && (
            <button className="refs-action" onClick={() => setPushOpen(true)}>
              Push to remotes…
            </button>
          )}
          {tab === "tags" && (
            <button className="refs-action" onClick={() => setCreateTagOpen(true)}>
              Create tag…
            </button>
          )}
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
                    <div className="refs-row-actions">
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
                      <button
                        className="refs-row-action"
                        aria-label={`Rename local branch ${branch.name}`}
                        title={
                          branch.checkedOutWorktreeIds.length > 0
                            ? "Switch every worktree away from this branch before renaming it"
                            : "Rename local branch"
                        }
                        disabled={branch.checkedOutWorktreeIds.length > 0}
                        onClick={() => setRenaming(branch)}
                      >
                        Rename
                      </button>
                      <button
                        className="refs-row-action is-danger"
                        aria-label={`Delete local branch ${branch.name}`}
                        title={
                          branch.checkedOutWorktreeIds.length > 0
                            ? "Switch every worktree away from this branch before deleting it"
                            : "Delete local branch"
                        }
                        disabled={
                          branch.checkedOutWorktreeIds.length > 0 ||
                          deleting !== null
                        }
                        onClick={() => void deleteBranch(branch)}
                      >
                        {deleting === branch.name ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                );
              })}
              {branches.length === 0 && !remoteSearch.loading && (
                <div className="refs-browser__empty">No matching branches.</div>
              )}
              {/* Count fetched rows, not rendered ones: a remote branch that
                  shadows a local one is still represented on screen — by the
                  local row it was folded into. Counting rendered rows instead
                  would leave the footer permanently short of its total with no
                  "Load more" to close the gap. */}
              <RefsPageFooter
                shown={localMatches.length + remoteSearch.rows.length}
                total={localMatches.length + remoteSearch.total}
                search={remoteSearch}
              />
            </div>
          )}

          {tab === "tags" && (
            <div className="refs-table refs-tag-table">
              {/* Object and Target were separate columns, and for a
                  lightweight tag they are the same object with the same type —
                  the overwhelming majority of rows repeated one id twice and
                  spent a quarter of the table doing it. One "points at" column
                  carries the peeled commit, which is what the tag marks; the
                  intermediate tag object an annotated tag adds appears only on
                  the rows that actually have one. */}
              <div className="refs-table__header refs-tag-table__row">
                <span>Tag</span>
                <span>Points at</span>
                <span>Annotation</span>
                <span>Actions</span>
              </div>
              {tagSearch.rows.map((tag) => (
                <div
                  className="refs-table__row refs-tag-table__row"
                  key={tag.fullName}
                >
                  <div className="refs-table__identity">
                    <span className="refs-tag-icon" aria-hidden="true">
                      #
                    </span>
                    <div>
                      <CopyTarget
                        value={tag.name}
                        label={`Copy tag name ${tag.name}`}
                        hint={`${tag.fullName}\nClick to copy tag name`}
                        className="refs-copyable-name copyable"
                      >
                        <strong>{tag.name}</strong>
                      </CopyTarget>
                      {/* Lightweight is the default and saying so on 97% of
                          rows is noise; annotated is the fact worth carrying. */}
                      {tag.kind === "annotated" && <small>annotated</small>}
                    </div>
                  </div>
                  <div className="refs-tag-object">
                    <span className="refs-tag-object__type">
                      {tag.targetType}
                    </span>
                    <CopyTarget
                      value={tag.targetId}
                      label={`Copy tag target ${tag.targetId}`}
                      hint={`${tag.targetId}\nClick to copy tag target`}
                      className="refs-plan__copy copyable"
                    >
                      {tag.targetId.slice(0, 12)}
                    </CopyTarget>
                    {/* Only when the tag ref does not point straight at the
                        commit — i.e. an annotated tag, where the tag object is
                        a distinct thing worth being able to copy. */}
                    {tag.objectId !== tag.targetId && (
                      <CopyTarget
                        value={tag.objectId}
                        label={`Copy tag object ${tag.objectId}`}
                        hint={`${tag.objectId}\nClick to copy the ${tag.objectType} object`}
                        className="refs-tag-object__via copyable"
                      >
                        via {tag.objectType} {tag.objectId.slice(0, 8)}
                      </CopyTarget>
                    )}
                  </div>
                  <div className="refs-tag-annotation">
                    {tag.annotation === undefined ? (
                      <span className="refs-table__muted">—</span>
                    ) : (
                      <>
                        <strong>{tag.annotation.subject || "Annotated tag"}</strong>
                        <small>
                          {tag.annotation.taggerName ?? "Unknown tagger"}
                          {tag.annotation.taggedAt === undefined
                            ? ""
                            : ` · ${shortWhen(tag.annotation.taggedAt, now)}`}
                        </small>
                        {tag.annotation.body !== undefined && (
                          <small title={tag.annotation.body}>
                            {tag.annotation.body}
                          </small>
                        )}
                      </>
                    )}
                  </div>
                  <div className="refs-tag-actions">
                    <button
                      className="refs-row-action"
                      disabled={refs.remotes.length === 0}
                      onClick={() => setRemoteTag(tag)}
                    >
                      Remote…
                    </button>
                    <button
                      className="refs-row-action is-danger"
                      aria-label={`Delete local tag ${tag.name}`}
                      disabled={deletingTag !== null}
                      onClick={() => void deleteLocalTag(tag)}
                    >
                      {deletingTag === tag.name ? "Deleting…" : "Delete local"}
                    </button>
                  </div>
                </div>
              ))}
              {/* "No matching" is only true when something was filtered out.
                  A repo with no tags at all is the common case here, and it
                  wants the answer plus the way forward, not a filter report. */}
              {tagSearch.rows.length === 0 && !tagSearch.loading && (
                <div className="refs-browser__empty">
                  {q === ""
                    ? "No local tags yet. Create one here, or right-click a commit in the graph."
                    : "No local tags match this filter."}
                </div>
              )}
              <RefsPageFooter
                shown={tagSearch.rows.length}
                total={tagSearch.total}
                search={tagSearch}
                noun="tags"
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
        {renaming !== null && (
          <BranchRenameDialog
            repoId={repo.id}
            branch={renaming}
            existingBranches={refs.branches.map((branch) => branch.name)}
            onRenamed={onRefresh}
            onClose={() => setRenaming(null)}
          />
        )}
        {createTagOpen && (
          <CreateTagDialog
            repoId={repo.id}
            repoName={repo.name}
            onCreated={tagsChanged}
            onClose={() => setCreateTagOpen(false)}
          />
        )}
        {remoteTag !== null && (
          <TagRemoteDialog
            repo={repo}
            tag={remoteTag}
            remotes={refs.remotes}
            // Nothing to refresh: pushing or deleting a remote tag leaves
            // every local ref, and so every row of this table, untouched.
            onCompleted={() => undefined}
            onClose={() => setRemoteTag(null)}
          />
        )}
      </div>
    </div>
  );
}
