import { useEffect, useState } from "react";
import type { Repo } from "@pwrgit/shared";
import { AppUpdateToast } from "../update/AppUpdateToast";
import { ReleaseNotesLink } from "../update/ReleaseNotesLink";
import { RemoteActivityToast } from "../remote/RemoteActivityToast";
import { dispatch } from "../../lib/pwrgit";
import {
  dismissToast,
  subscribeToasts,
  type Toast,
  type ToastSubject
} from "../../lib/toast";
import {
  hoverTooltip,
  useViewportTooltip,
  type ViewportTooltip
} from "../../lib/useViewportTooltip";

const AUTO_DISMISS_MS = 9_000;

/** Bottom-right stack of error toasts (adapted from PwrAgnt's AppNoticeToast).
 *  Always visible regardless of pane widths — the fallback surface for errors
 *  whose inline chrome may be collapsed away.
 *
 *  The update toast rides at the bottom of the same stack: it outlives every
 *  transient notice, so anchoring it to the corner keeps it from being shoved
 *  around as errors come and go. The container is rendered even when empty —
 *  a childless flex column at a fixed corner has no size and paints nothing. */
export function ToastHost({
  selectedWorktreeId = null,
  repos,
  onReveal
}: {
  /** The checkout on screen — its own toolbar reports its operations, so the
   *  activity cards below skip it. */
  selectedWorktreeId?: string | null;
  /** This window's repositories, for naming a toast's subject — see
   *  `ToastSubject` for why a toast carries an id and not a name. */
  repos: readonly Repo[];
  /** Where a subject chip goes: the repository in the sidebar, and with
   *  `remote`, that remote's row inside it. */
  onReveal: (repoId: string, remote: string | null) => void;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="toast-host">
      {/* Keyed by `key` where there is one, so a replacement updates the card
          in place: remounting would drop the hover-pause of a pointer that is
          already resting on it and never fires onMouseEnter again.

          Sticky cards sort after the transients for the same reason the
          update toast anchors the corner: a card that outlives the come-and-go
          must not be shoved around by it. In this bottom-anchored column the
          later children sit nearer the corner, and growth above them leaves
          them still. */}
      {[...toasts]
        .sort((a, b) => Number(a.sticky === true) - Number(b.sticky === true))
        .map((toast) => (
          <ToastCard
            key={toast.key ?? toast.id}
            toast={toast}
            subject={
              toast.subject === undefined
                ? null
                : resolveSubject(toast.subject, repos)
            }
            onReveal={onReveal}
          />
        ))}
      {/* Live operations sit below the transient notices and above the update
          card, for the reason the sort above gives: they outlive the come-and-go
          and must not be shoved around by it. */}
      <RemoteActivityToast selectedWorktreeId={selectedWorktreeId} />
      <AppUpdateToast />
    </div>
  );
}

/** A subject with its repository found: what the chips draw. */
type NamedSubject = {
  repoId: string;
  repoName: string;
  remote?: { name: string; url?: string };
};

/**
 * Looks a subject up by repo or worktree id; null for a repository that is
 * no longer in this window's list.
 *
 * A scan per card rather than an index over the list: `repos` changes on every
 * `repo:changed`, the stack is usually empty, and a handful of cards is all it
 * ever holds.
 */
function resolveSubject(
  subject: ToastSubject,
  repos: readonly Repo[]
): NamedSubject | null {
  const repo =
    "repoId" in subject
      ? repos.find((candidate) => candidate.id === subject.repoId)
      : repos.find((candidate) =>
          candidate.worktrees.some(
            (worktree) => worktree.id === subject.worktreeId
          )
        );
  if (repo === undefined) return null;
  return {
    repoId: repo.id,
    repoName: repo.name,
    ...(subject.remote === undefined ? {} : { remote: subject.remote })
  };
}

function ToastCard({
  toast,
  subject,
  onReveal
}: {
  toast: Toast;
  subject: NamedSubject | null;
  onReveal: (repoId: string, remote: string | null) => void;
}) {
  const tip = useViewportTooltip();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || toast.sticky === true) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [paused, toast.id, toast.sticky]);

  return (
    <aside
      className="app-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="app-toast__content">
        <p
          className={
            toast.tone === "error"
              ? "app-toast__eyebrow"
              : "app-toast__eyebrow app-toast__eyebrow--info"
          }
        >
          {toast.title}
        </p>
        {subject !== null && (
          <SubjectChips subject={subject} tip={tip} onReveal={onReveal} />
        )}
        <p className="app-toast__message">{toast.message}</p>
        {toast.detail !== undefined && toast.detail !== toast.message && (
          <p className="app-toast__detail">{toast.detail}</p>
        )}
      </div>
      <div className="app-toast__actions">
        {/* Before the generic actions: a card that says "You're running
            v0.16.1" is the only place that version appears, and the way to
            read what is in it belongs beside the claim, not after Dismiss.
            `undefined` on every toast that names no version, and the control
            renders nothing for it. */}
        <ReleaseNotesLink
          url={toast.notesUrl}
          className="app-toast__notes"
        />
        {toast.showLogsAction !== false && (
          <button
            className="app-toast__button"
            type="button"
            {...hoverTooltip(tip, "Open the Logs window")}
            onClick={() => void dispatch("logs:openWindow", undefined)}
          >
            Logs
          </button>
        )}
        {toast.showCopyAction !== false && (
          <button
            className="app-toast__button"
            type="button"
            aria-label={toast.copyLabel ?? "Copy error"}
            {...hoverTooltip(tip, toast.copyLabel ?? "Copy error")}
            onClick={() => {
              void navigator.clipboard.writeText(
                toast.copyText ??
                  [
                    toast.title,
                    subject && subjectLine(subject),
                    toast.message,
                    toast.detail
                  ]
                    .filter(Boolean)
                    .join("\n")
              );
            }}
          >
            {toast.copyLabel ?? "Copy"}
          </button>
        )}
        <button
          className="app-toast__button"
          type="button"
          aria-label="Dismiss"
          {...hoverTooltip(tip, "Dismiss")}
          onClick={() => dismissToast(toast.id)}
        >
          ✕
        </button>
      </div>
      {/* Keyed by id so a replacement restarts the countdown animation, which
          runs on mount, in step with the timer effect above. A sticky toast
          has no countdown, so it shows no bar draining toward one. */}
      {toast.sticky !== true && (
        <span
          key={toast.id}
          className="app-toast__timer"
          aria-hidden="true"
          data-paused={paused ? "true" : undefined}
        />
      )}
      {tip.tooltipNode}
    </aside>
  );
}

/** The subject as plain text, for a copied report: pasted into an issue, the
 *  chips are gone and "Fetch failed" alone does not say where. */
function subjectLine(subject: NamedSubject): string {
  return subject.remote === undefined
    ? `Repository: ${subject.repoName}`
    : `Repository: ${subject.repoName} · Remote: ${subject.remote.name}`;
}

/**
 * Where the toast happened, as a way back there: `diskhound › upstream`.
 *
 * Between the eyebrow and the message, because it is what tells two cards
 * apart — a stack of "Fetched origin" from three repositories reads as one
 * repeated notice until each says whose origin. Chips rather than prose since
 * each one goes somewhere, and a repo name set in a sentence gives no hint
 * that it can be clicked.
 *
 * The remote chip keeps its URL in the tooltip, where the caller had one to
 * give: `upstream` is a name every fork has, and the URL is what says which
 * one this is.
 */
function SubjectChips({
  subject,
  tip,
  onReveal
}: {
  subject: NamedSubject;
  tip: ViewportTooltip;
  onReveal: (repoId: string, remote: string | null) => void;
}) {
  const { remote } = subject;
  return (
    <p className="app-toast__subject">
      <button
        type="button"
        className="app-toast__chip"
        aria-label={`Show ${subject.repoName} in the sidebar`}
        {...hoverTooltip(tip, "Show in the sidebar")}
        onClick={() => {
          tip.hide();
          onReveal(subject.repoId, null);
        }}
      >
        <span className="app-toast__chip-name">{subject.repoName}</span>
      </button>
      {remote !== undefined && (
        <>
          <span className="app-toast__subject-sep" aria-hidden="true">
            ›
          </span>
          <button
            type="button"
            className="app-toast__chip"
            aria-label={`Show remote ${remote.name} of ${subject.repoName} in the sidebar`}
            {...hoverTooltip(
              tip,
              remote.url === undefined ? (
                "Show in the sidebar"
              ) : (
                <span className="app-toast__chip-tip">
                  <strong>Show in the sidebar</strong>
                  <span>{remote.url}</span>
                </span>
              )
            )}
            onClick={() => {
              tip.hide();
              onReveal(subject.repoId, remote.name);
            }}
          >
            <span className="app-toast__chip-name">{remote.name}</span>
          </button>
        </>
      )}
    </p>
  );
}
