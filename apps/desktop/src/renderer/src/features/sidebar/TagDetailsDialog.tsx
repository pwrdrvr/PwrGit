import { useCallback, useEffect, useState } from "react";
import type { Repo, TagDetails } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { useModal } from "../../lib/useModal";
import { confirmDialog } from "../shell/dialogs";
import { CopyTarget } from "../shell/CopyTarget";
import { checkedAgo } from "./TagSourceStrip";

const short = (id: string): string => id.slice(0, 12);

/**
 * Every source's own value for one tag name: local, each remote PwrGit has
 * listed, and every value it replaced. Same names with different objects stay
 * distinct here, because no remote may decide what a shared name means.
 * Design: design/Published Tags - UX Review.dc.html, 3c.
 */
export function TagDetailsDialog({
  repo,
  name,
  now,
  onChanged,
  onClose
}: {
  repo: Repo;
  name: string;
  now: number;
  /** The local tag moved (a restore) or a remote was listed. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<TagDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const modalRef = useModal<HTMLDivElement>({ onClose });

  const load = useCallback(async (): Promise<void> => {
    const result = await dispatch("tag:details", { repoId: repo.id, name });
    if (!result.ok) {
      setError(result.error.message.split("\n")[0] ?? "Load failed");
      return;
    }
    setError(null);
    setDetails(result.value);
  }, [name, repo.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = async (remote: string): Promise<void> => {
    if (busy !== null) return;
    setBusy(`check:${remote}`);
    const result = await dispatch("tag:refreshRemote", { repoId: repo.id, remote, mode: "explicit" });
    setBusy(null);
    if (!result.ok) {
      showErrorToast({
        title: `Couldn't check ${remote}'s tags`,
        message: result.error.message.split("\n")[0],
        detail: result.error.message,
        subject: { repoId: repo.id, remote: { name: remote } }
      });
      return;
    }
    onChanged();
    await load();
  };

  const restore = async (ref: string, objectId: string): Promise<void> => {
    if (busy !== null || details === null) return;
    const current = details.local;
    const confirmed = await confirmDialog({
      title: `Restore ${name} to ${short(objectId)}?`,
      message:
        current === null
          ? `This recreates local ${name} at the value PwrGit kept.`
          : `Local ${name} now names ${short(current.objectId)}. PwrGit keeps that value under refs/pwrgit/replaced-tags/ first, so this can be undone the same way.`,
      confirmLabel: "Restore tag"
    });
    if (!confirmed) return;
    setBusy(`restore:${ref}`);
    const result = await dispatch("tag:restoreReplaced", {
      repoId: repo.id,
      name,
      ref,
      expectedLocalObjectId: current?.objectId ?? null
    });
    setBusy(null);
    if (!result.ok) {
      showErrorToast({
        title: "Restore tag failed",
        message: result.error.message.split("\n")[0],
        detail: result.error.message,
        subject: { repoId: repo.id }
      });
      return;
    }
    showInfoToast({ title: `Restored ${name}`, message: short(result.value.objectId), subject: { repoId: repo.id } });
    onChanged();
    await load();
  };

  const local = details?.local ?? null;
  return (
    <div className="overlay-backdrop refs-push-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        aria-modal="true"
        tabIndex={-1}
        className="modal refs-tag-dialog refs-tag-details"
        role="dialog"
        aria-label={`${name} across sources`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">{name} across sources</div>
        {error !== null && <div className="modal__error">{error}</div>}
        {details === null && error === null && <div className="modal__hint">Reading&hellip;</div>}
        {details !== null && (
          <>
            <div className="refs-tag-compare" role="table" aria-label={`Values of ${name}`}>
              <div className="refs-tag-compare__row refs-tag-compare__row--head" role="row">
                <span role="columnheader">Source</span>
                <span role="columnheader">Kind</span>
                <span role="columnheader">Points at</span>
                <span role="columnheader">Objects</span>
              </div>
              <div className="refs-tag-compare__row" role="row">
                <span role="cell" className="refs-tag-compare__source">
                  Local<small>refs/tags/{name}</small>
                </span>
                <span role="cell">{local?.kind ?? "—"}</span>
                <span role="cell" className="refs-tag-compare__target">
                  {local === null ? (
                    "no local tag"
                  ) : (
                    <>
                      <CopyTarget value={local.targetId} label={`Copy local target ${local.targetId}`} className="copyable">
                        {short(local.targetId)}
                      </CopyTarget>
                      {local.objectId !== local.targetId && <small>via tag {local.objectId.slice(0, 8)}</small>}
                    </>
                  )}
                </span>
                <span role="cell" className="refs-tag-compare__flag is-here">
                  {local === null ? "" : "here"}
                </span>
              </div>
              {details.remotes.map((remote) => (
                <div className="refs-tag-compare__row" role="row" key={remote.remote}>
                  <span role="cell" className="refs-tag-compare__source">
                    {remote.remote}
                    {remote.published ? " · published" : ""}
                    <small>
                      {remote.checkedAt === null ? "not checked" : `checked ${checkedAgo(remote.checkedAt, now)}`}
                    </small>
                  </span>
                  <span role="cell">{remote.value?.kind ?? "—"}</span>
                  <span role="cell" className="refs-tag-compare__target">
                    {remote.value === null ? (
                      remote.checkedAt === null ? "—" : "not on this remote"
                    ) : (
                      <>
                        <CopyTarget
                          value={remote.value.targetId}
                          label={`Copy ${remote.remote} target ${remote.value.targetId}`}
                          className="copyable"
                        >
                          {short(remote.value.targetId)}
                        </CopyTarget>
                        {remote.value.objectId !== remote.value.targetId && (
                          <small>via tag {remote.value.objectId.slice(0, 8)}</small>
                        )}
                      </>
                    )}
                  </span>
                  <span role="cell">
                    {remote.checkedAt === null ? (
                      <button
                        className="refs-row-action refs-row-action--quiet"
                        aria-disabled={busy !== null}
                        aria-label={`Check ${remote.remote}'s tags`}
                        onClick={() => void check(remote.remote)}
                      >
                        {busy === `check:${remote.remote}` ? "Checking…" : "Check"}
                      </button>
                    ) : remote.value === null ? null : (
                      <span className={`refs-tag-compare__flag${remote.value.available === true ? " is-here" : " is-missing"}`}>
                        {remote.value.available === true ? "here" : "not downloaded"}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {details.replaced.length > 0 && (
              <>
                <div className="refs-tag-details__section">Replaced earlier</div>
                {details.replaced.map((replaced) => (
                  <div className="refs-tag-replaced" key={replaced.ref}>
                    <div>
                      <div className="refs-tag-replaced__value">
                        {short(replaced.targetId)} &middot; {replaced.kind} &middot; replaced{" "}
                        {new Date(replaced.replacedAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit"
                        })}
                      </div>
                      <CopyTarget value={replaced.ref} label={`Copy ref ${replaced.ref}`} className="refs-tag-replaced__ref copyable">
                        {replaced.ref}
                      </CopyTarget>
                    </div>
                    <button
                      className="refs-row-action refs-row-action--quiet"
                      aria-disabled={busy !== null}
                      onClick={() => void restore(replaced.ref, replaced.objectId)}
                    >
                      {busy === `restore:${replaced.ref}` ? "Restoring…" : "Restore"}
                    </button>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
