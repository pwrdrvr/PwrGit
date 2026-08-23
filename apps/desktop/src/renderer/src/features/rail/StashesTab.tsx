import { useEffect, useRef, useState } from "react";
import type { StashDetails, StashEntry, Worktree } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { confirmDialog } from "../shell/dialogs";

type DetailsState =
  | { kind: "loading" }
  | { kind: "ready"; value: StashDetails }
  | { kind: "error"; message: string };

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function displayName(entry: StashEntry): string {
  return entry.name ?? entry.subject;
}

function entryKey(entry: StashEntry): string {
  return entry.selector + ":" + entry.hash;
}

export function StashesTab({
  worktree,
  entries,
  loading,
  reload,
  onOpenPatch
}: {
  worktree: Worktree | null;
  entries: StashEntry[];
  loading: boolean;
  reload: () => Promise<void>;
  onOpenPatch: (hash: string, subject: string) => void;
}) {
  const [name, setName] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [expandedEntryKey, setExpandedEntryKey] = useState<string | null>(null);
  const [details, setDetails] = useState<DetailsState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const detailsGeneration = useRef(0);
  const currentWorktreeId = useRef(worktree?.id ?? null);
  // Update during render rather than in an effect: an old promise can settle
  // after the selected prop changes but before effects for that render run.
  currentWorktreeId.current = worktree?.id ?? null;

  useEffect(() => {
    detailsGeneration.current += 1;
    setName("");
    setExpandedEntryKey(null);
    setDetails(null);
    setBusy(null);
  }, [worktree?.id]);

  useEffect(() => {
    if (
      expandedEntryKey !== null &&
      !entries.some((entry) => entryKey(entry) === expandedEntryKey)
    ) {
      detailsGeneration.current += 1;
      setExpandedEntryKey(null);
      setDetails(null);
    }
  }, [entries, expandedEntryKey]);

  const toggleDetails = (entry: StashEntry): void => {
    if (worktree === null) return;
    const selectedEntryKey = entryKey(entry);
    const worktreeId = worktree.id;
    if (expandedEntryKey === selectedEntryKey) {
      detailsGeneration.current += 1;
      setExpandedEntryKey(null);
      setDetails(null);
      return;
    }
    setExpandedEntryKey(selectedEntryKey);
    setDetails({ kind: "loading" });
    const generation = ++detailsGeneration.current;
    void dispatch("stash:details", {
      worktreeId,
      stashHash: entry.hash
    }).then((result) => {
      if (
        detailsGeneration.current !== generation ||
        currentWorktreeId.current !== worktreeId
      ) {
        return;
      }
      setDetails(
        result.ok
          ? { kind: "ready", value: result.value }
          : { kind: "error", message: result.error.message }
      );
    });
  };

  const create = async (): Promise<void> => {
    if (worktree === null || name.trim() === "") return;
    const worktreeId = worktree.id;
    const message = name.trim();
    setBusy("create");
    const result = await dispatch("stash:create", {
      worktreeId,
      message,
      includeUntracked
    });
    if (currentWorktreeId.current !== worktreeId) return;
    setBusy(null);
    await reload();
    if (currentWorktreeId.current !== worktreeId) return;
    if (!result.ok) {
      showErrorToast({
        title: "Could not create stash",
        message: result.error.message,
        detail: message
      });
      return;
    }
    if (!result.value.created) {
      showInfoToast({
        title: "Nothing stashed",
        message: includeUntracked
          ? "This worktree has no changes to save."
          : "There are no tracked changes to save. Include untracked files if that is the work you want to stash."
      });
      return;
    }
    showInfoToast({
      title: "Stash created",
      message: message + " was added to the repository stack."
    });
    setName("");
  };

  const restore = async (
    entry: StashEntry,
    command: "stash:apply" | "stash:pop"
  ): Promise<void> => {
    if (worktree === null) return;
    const worktreeId = worktree.id;
    setBusy(command + ":" + entry.hash);
    const result = await dispatch(command, {
      worktreeId,
      stashHash: entry.hash
    });
    if (currentWorktreeId.current !== worktreeId) return;
    setBusy(null);
    await reload();
    if (currentWorktreeId.current !== worktreeId) return;
    if (!result.ok) {
      showErrorToast({
        title:
          command === "stash:pop"
            ? "Pop stopped — stash kept"
            : "Apply stopped",
        message: result.error.message,
        detail: entry.selector + " " + displayName(entry)
      });
      return;
    }
    showInfoToast({
      title: command === "stash:pop" ? "Stash popped" : "Stash applied",
      message:
        command === "stash:pop"
          ? displayName(entry) +
            " was restored here and removed from the repository stack."
          : displayName(entry) +
            " was restored here and kept in the repository stack."
    });
  };

  const drop = async (entry: StashEntry): Promise<void> => {
    if (worktree === null || entry.occurrenceCount > 1) return;
    const worktreeId = worktree.id;
    const confirmed = await confirmDialog({
      title: "Drop repository stash?",
      message:
        "Permanently drop “" +
        displayName(entry) +
        "”? This entry is shared by every worktree and may be impossible to recover.",
      confirmLabel: "Drop stash",
      danger: true
    });
    if (!confirmed || currentWorktreeId.current !== worktreeId) return;
    setBusy("stash:drop:" + entry.hash);
    const result = await dispatch("stash:drop", {
      worktreeId,
      stashHash: entry.hash
    });
    if (currentWorktreeId.current !== worktreeId) return;
    setBusy(null);
    await reload();
    if (currentWorktreeId.current !== worktreeId) return;
    if (!result.ok) {
      showErrorToast({
        title: "Could not drop stash",
        message: result.error.message,
        detail: entry.selector + " " + displayName(entry)
      });
    }
  };

  if (worktree === null) {
    return <div className="rail-empty">Select a worktree to manage stashes.</div>;
  }

  return (
    <div className="stashes-tab">
      <div className="stash-scope" role="note">
        <strong>One Git stash stack for this repository.</strong>
        <span>
          Every linked worktree sees these entries. Apply and Pop restore into{" "}
          <code>{worktree.branch}</code> in this worktree.
        </span>
      </div>

      <div className="stash-create">
        <label htmlFor="stash-name">Name this stash</label>
        <div className="stash-create__row">
          <input
            id="stash-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
            placeholder="e.g. parser experiment"
          />
          <button
            onClick={() => void create()}
            disabled={name.trim() === "" || busy !== null}
          >
            Stash changes
          </button>
        </div>
        <label className="stash-create__option">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(event) => setIncludeUntracked(event.target.checked)}
          />
          Include untracked files
        </label>
      </div>

      <div className="stash-list">
        <div className="stash-list__head">
          Repository stack · {entries.length}
        </div>
        {loading && entries.length === 0 ? (
          <div className="stash-empty">Loading stashes…</div>
        ) : entries.length === 0 ? (
          <div className="stash-empty">
            No stash entries. Terminal-created stashes appear here too.
          </div>
        ) : (
          entries.map((entry) => {
            const renderedEntryKey = entryKey(entry);
            const expanded = expandedEntryKey === renderedEntryKey;
            const entryBusy = busy?.endsWith(entry.hash) === true;
            return (
              <article className="stash-entry" key={renderedEntryKey}>
                <button
                  className="stash-entry__toggle"
                  onClick={() => toggleDetails(entry)}
                  aria-expanded={expanded}
                  aria-label={
                    (expanded ? "Hide " : "Inspect ") + displayName(entry)
                  }
                >
                  <span className="stash-entry__twisty" aria-hidden="true">
                    {expanded ? "⌄" : "›"}
                  </span>
                  <span className="stash-entry__identity">
                    <strong title={entry.subject}>
                      {displayName(entry)}
                      {entry.kind === "pwrgit-pull-recovery" && (
                        <span className="stash-entry__recovery">
                          PwrGit pull recovery
                        </span>
                      )}
                    </strong>
                    <span>
                      {entry.selector} · {entry.shortHash} · on{" "}
                      {entry.branch ?? "unknown branch"}
                    </span>
                  </span>
                  <time dateTime={entry.createdAt}>
                    {dateTime.format(new Date(entry.createdAt))}
                  </time>
                </button>

                {expanded && (
                  <div className="stash-entry__body">
                    <div className="stash-entry__actions">
                      <button
                        onClick={() => void restore(entry, "stash:apply")}
                        disabled={busy !== null}
                        title="Restore here and keep this stash"
                      >
                        Apply
                      </button>
                      <button
                        onClick={() => void restore(entry, "stash:pop")}
                        disabled={busy !== null || entry.occurrenceCount > 1}
                        title={
                          entry.occurrenceCount > 1
                            ? "Unavailable while this stash object occurs more than once"
                            : "Restore here; Git drops it only if apply succeeds"
                        }
                      >
                        Pop
                      </button>
                      <button
                        onClick={() =>
                          onOpenPatch(entry.hash, displayName(entry))
                        }
                        disabled={busy !== null}
                      >
                        View patch
                      </button>
                      <button
                        className="stash-entry__drop"
                        onClick={() => void drop(entry)}
                        disabled={busy !== null || entry.occurrenceCount > 1}
                        title={
                          entry.occurrenceCount > 1
                            ? "Unavailable while this stash object occurs more than once"
                            : "Permanently remove this repository stash"
                        }
                      >
                        Drop
                      </button>
                    </div>

                    {entry.occurrenceCount > 1 && (
                      <div className="stash-details__duplicate" role="note">
                        This same Git stash object appears {entry.occurrenceCount} times.
                        Apply and inspection are safe; Pop and Drop are
                        disabled because reflog occurrences have no stable
                        identity.
                      </div>
                    )}

                    {entryBusy || details?.kind === "loading" ? (
                      <div className="stash-details__status">Working…</div>
                    ) : details?.kind === "error" ? (
                      <div className="stash-details__status stash-details__status--error">
                        {details.message}
                      </div>
                    ) : details?.kind === "ready" ? (
                      <>
                        <div className="stash-details__summary">
                          {details.value.files.length} file
                          {details.value.files.length === 1 ? "" : "s"} ·{" "}
                          <span>+{details.value.additions}</span>{" "}
                          <span>−{details.value.deletions}</span>
                        </div>
                        <div className="stash-files">
                          {details.value.files.map((file) => (
                            <div className="stash-file" key={file.path}>
                              <span
                                className="stash-file__path"
                                title={file.path}
                              >
                                {file.path}
                              </span>
                              <span className="stash-file__stat">
                                {file.additions === null
                                  ? "binary"
                                  : "+" +
                                    file.additions +
                                    " −" +
                                    (file.deletions ?? 0)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
