import { useEffect, useRef, useState } from "react";
import type { ResolvedCommit, TagSummary } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";

/** Long enough that resolution doesn't fire on every keystroke of a pasted id. */
const RESOLVE_DEBOUNCE_MS = 250;

export function CreateTagDialog({
  repoId,
  repoName,
  initialTarget,
  onCreated,
  onClose
}: {
  repoId: string;
  repoName: string;
  /** Seeds the target when the dialog is opened from a commit. */
  initialTarget?: string;
  onCreated: (tag: TagSummary) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [targetCommit, setTargetCommit] = useState(initialTarget ?? "HEAD");
  const [kind, setKind] = useState<"lightweight" | "annotated">("lightweight");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedCommit | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  /** Only the newest resolution may write state; typing outruns git. */
  const generation = useRef(0);

  const target = targetCommit.trim();

  // Resolve whatever is in the field to one commit, and show it. The tag is
  // then created at the resolved object id — never at the typed name — so
  // `tag:create`'s explicit-id contract is untouched and the user has seen
  // exactly which commit they are marking.
  useEffect(() => {
    if (target === "") {
      generation.current += 1;
      setResolved(null);
      setResolveError(null);
      setResolving(false);
      return;
    }
    setResolving(true);
    const timer = setTimeout(() => {
      const stamp = ++generation.current;
      void dispatch("tag:resolveCommit", { repoId, revision: target }).then(
        (result) => {
          if (stamp !== generation.current) return;
          setResolving(false);
          if (result.ok) {
            setResolved(result.value);
            setResolveError(null);
            return;
          }
          setResolved(null);
          setResolveError(result.error.message.split("\n")[0] ?? "Unresolved");
        }
      );
    }, RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [repoId, target]);

  const valid =
    name.trim() !== "" &&
    resolved !== null &&
    (kind === "lightweight" || message.trim() !== "");

  const create = async (): Promise<void> => {
    if (!valid || busy || resolved === null) return;
    setBusy(true);
    setError(null);
    const result = await dispatch("tag:create", {
      repoId,
      name: name.trim(),
      targetCommit: resolved.commitId,
      kind,
      ...(kind === "annotated" ? { message: message.trim() } : {})
    });
    setBusy(false);
    if (!result.ok) {
      const summary = result.error.message.split("\n")[0];
      setError(summary);
      showErrorToast({
        title: "Create tag failed",
        message: summary,
        detail: result.error.message
      });
      return;
    }
    showInfoToast({
      title: "Tag created",
      message: `${result.value.name} points to ${result.value.targetId.slice(0, 12)}.`
    });
    onCreated(result.value);
    onClose();
  };

  return (
    <div className="overlay-backdrop refs-push-backdrop" onClick={onClose}>
      <div
        className="modal refs-tag-dialog"
        role="dialog"
        aria-label={`Create tag in ${repoName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">Create tag · {repoName}</div>
        <label className="refs-field">
          <span>Tag name</span>
          <input
            autoFocus
            aria-label="Tag name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="v1.2.0"
          />
        </label>
        <label className="refs-field">
          <span>Target</span>
          <input
            aria-label="Target"
            value={targetCommit}
            aria-invalid={resolveError !== null}
            onChange={(event) => setTargetCommit(event.target.value)}
            placeholder="HEAD, a branch, a tag, or a commit ID"
          />
        </label>
        {/* The resolution, always on screen: the field accepts a name, the tag
            is created at an object id, and this is where those two meet. */}
        <div className="refs-tag-resolved" aria-live="polite">
          {resolveError !== null ? (
            <span className="refs-tag-resolved__error">{resolveError}</span>
          ) : resolved === null ? (
            <span className="refs-tag-resolved__pending">
              {target === ""
                ? "Enter a commit, branch, or tag to mark."
                : "Resolving…"}
            </span>
          ) : (
            <>
              <div className="refs-tag-resolved__top">
                <span className="refs-tag-resolved__sha">
                  {resolved.shortId}
                </span>
                <span className="refs-tag-resolved__meta">
                  {resolved.authorName}
                  {resolved.resolvedFrom === undefined
                    ? ""
                    : ` · ${resolved.resolvedFrom} is here now`}
                </span>
              </div>
              <div className="refs-tag-resolved__subject">
                {resolved.subject}
              </div>
            </>
          )}
        </div>
        <label className="refs-field">
          <span>Tag kind</span>
          <select
            aria-label="Tag kind"
            value={kind}
            onChange={(event) => {
              const value = event.target.value;
              setKind(value === "annotated" ? "annotated" : "lightweight");
            }}
          >
            <option value="lightweight">Lightweight</option>
            <option value="annotated">Annotated</option>
          </select>
        </label>
        {kind === "annotated" && (
          <label className="refs-field refs-field--message">
            <span>Annotation</span>
            <textarea
              aria-label="Annotation"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Release notes or tag message"
            />
          </label>
        )}
        <div className="modal__hint">
          Tags are repository refs, not branches. Creating one never switches a
          worktree. The tag is written at the commit shown above, not at the
          name you typed — a branch that moves later leaves the tag behind.
        </div>
        {error !== null && (
          <div className="modal__error" role="alert">
            {error}
          </div>
        )}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            disabled={!valid || busy || resolving}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create tag"}
          </button>
        </div>
      </div>
    </div>
  );
}
