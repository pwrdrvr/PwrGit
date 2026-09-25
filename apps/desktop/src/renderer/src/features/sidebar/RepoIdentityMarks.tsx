import { useRef, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import {
  forgeProductFor,
  type CloneRepository,
  type ForgeHost,
  type RepoIdentity,
  type RepoVisibility
} from "@pwrgit/shared";

/**
 * The repo identity marks: two independent axes plus the host.
 *
 * Visibility always occupies its slot, so a repo row's name edge never moves
 * and "no lock" cannot be misread as "not loaded yet" — only `private` and
 * `internal` take colour. Lineage is drawn ONLY when a repo is a fork: most
 * repos are sources, and a "source" mark on every row says nothing while
 * costing a column.
 */

const VISIBILITY_LABEL: Record<RepoVisibility, string> = {
  public: "public",
  private: "private",
  internal: "internal",
  unknown: "unknown"
};

function hostLabel(host: ForgeHost, hostname: string): string {
  const product = forgeProductFor(host);
  if (product !== null && hostname === product.saasHost) {
    return product.label.toUpperCase();
  }
  // A self-hosted instance is named, not badged with a forge that would
  // misstate where the code actually lives.
  return hostname.toUpperCase();
}

function visibilityTitle(
  visibility: RepoVisibility,
  hostname: string
): string {
  if (visibility === "unknown") {
    return `PwrGit could not read this repository's visibility on ${hostname}`;
  }
  return `${VISIBILITY_LABEL[visibility]} on ${hostname}`;
}

/** Lucide `globe`. */
function GlobeIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

/** Lucide `lock`. */
function LockIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/** Lucide `building-2`, trimmed of the window rows that turn to mud at 12px. */
function BuildingIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
    </svg>
  );
}

/** Lucide `circle-help`. */
function UnknownIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Lucide `git-fork`. */
export function GitForkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </svg>
  );
}

function VisibilityIcon({
  visibility,
  size
}: {
  visibility: RepoVisibility;
  size: number;
}) {
  if (visibility === "private") return <LockIcon size={size} />;
  if (visibility === "internal") return <BuildingIcon size={size} />;
  if (visibility === "unknown") return <UnknownIcon size={size} />;
  return <GlobeIcon size={size} />;
}

/**
 * Lucide `ban`.
 *
 * Deliberately the simplest glyph that says "not allowed" rather than a
 * pencil-with-a-slash: this is drawn at 12px in a row of other 12px marks, and
 * a circle and one stroke survive that size where a pencil does not. What it
 * means comes from the title beside it, which names the repository.
 */
function NoPushIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}

/**
 * What to say about push access, or null when there is nothing to say.
 *
 * The ONE spelling of this sentence. Three surfaces show it — the sidebar
 * glyph, the clone/fork row chip, and the worktree header's button — and a
 * second copy is a second thing to keep in step with the verb it names.
 *
 * Three states and only one of them draws: `true` is the ordinary case and a
 * mark on every row you CAN push to costs a column to say nothing, while
 * `undefined` is "not known" and must stay silent — a forge that does not
 * report it, or a row written before PwrGit asked. Only a forge that said no
 * gets a glyph.
 */
export function pushAccessTitle(
  /** `RepoIdentity` or `CloneRepository` — both carry the same two fields, and
   *  the question is the same about either. */
  identity: Pick<RepoIdentity, "viewerCanPush" | "nameWithOwner">
): string | null {
  if (identity.viewerCanPush !== false) return null;
  return `You can't push to ${identity.nameWithOwner}. Fork it to contribute.`;
}

/**
 * The read-only mark, wherever the fact is true.
 *
 * Its own component because two surfaces show it about the same repository —
 * the repo row, and the `origin` row under REMOTES, which is the remote the
 * fact is actually about. Both want the same glyph, the same sentence and the
 * same verb, and a second copy is a second thing to keep in step.
 *
 * `onFork` is what turns it from a statement into a way out. Without one it
 * stays a passive mark rather than growing a button that goes nowhere.
 */
export function NoPushMark({
  identity,
  onFork,
  decorative = false,
  size = 12
}: {
  identity: Pick<RepoIdentity, "viewerCanPush" | "nameWithOwner">;
  onFork?: () => void;
  /** Rendered inside a control that already has its own accessible name —
   *  the `origin` disclosure button under REMOTES. An `aria-label` there is
   *  not a second name, it is spliced INTO that button's name, which is how
   *  "origin" becomes "origin You can't push to desktop/dugite. Fork it to
   *  contribute. default". `ForgeChip` beside it is `aria-hidden` for the same
   *  reason; the words reach a screen reader through the row's own
   *  description, and through the fork button's label right beside it. */
  decorative?: boolean;
  size?: number;
}) {
  const tip = useViewportTooltip();
  const title = pushAccessTitle(identity);
  if (title === null) return null;
  if (onFork === undefined) {
    return (
      <>
        <span
          className="repo-mark repo-mark--nopush"
          // A meaningful glyph, so it is named rather than decorative. This is
          // what `title` was reaching for and could not reliably deliver: a
          // `title` on a span is advisory, is not a reliable accessible name,
          // and cannot be dismissed (SC 1.4.13).
          {...(decorative
            ? { "aria-hidden": true }
            : { role: "img", "aria-label": title })}
          {...hoverTooltip(tip, title)}
        >
          <NoPushIcon size={size} />
        </span>
        {tip.tooltipNode}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className="repo-mark repo-mark--nopush is-actionable"
        aria-label={`${title} Fork it now.`}
        {...hoverTooltip(tip, `${title} Click to fork it.`)}
        onClick={(event) => {
          event.stopPropagation();
          tip.hide();
          onFork();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <NoPushIcon size={size} />
      </button>
      {tip.tooltipNode}
    </>
  );
}

/**
 * The dense variant: glyphs only, for the 320px sidebar. The parent slug has
 * nowhere to go at this width, so it lives on the mark itself — as the
 * accessible name, and as the hover card `useViewportTooltip` draws. It used
 * to live in a `title`, which on these marks rendered nothing at all.
 */
export function RepoIdentityGlyphs({
  identity,
  repoId,
  profileId,
  onFork
}: {
  identity: RepoIdentity;
  repoId: string;
  profileId: string;
  /** Open the fork prompt for this repository. Optional: without it the
   *  read-only mark stays the passive statement it was, so a caller that has
   *  nowhere to send the user does not grow a dead button. */
  onFork?: () => void;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const refresh = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await dispatch("repo:refreshIdentities", {
        profileId,
        repoId,
        force: true
      });
      const outcome = result.ok
        ? result.value.outcomes.find((entry) => entry.repoId === repoId)
        : undefined;
      // A host the user switched off is the one outcome here that is a choice
      // rather than a failure: say so, and do not paint it red. Reporting it as
      // "still unknown" contradicted a lock glyph rendering a known `private`
      // and sent the user to an empty log.
      const disabled = outcome?.status === "host_disabled";
      const unresolved = !disabled && outcome?.status !== "resolved";
      const message = !result.ok ? result.error.message
        : disabled
          // The host main gated on, not the one in the stored row: those differ
          // whenever `origin` has moved, and naming the stored one sends the
          // user to a switch that is already on.
          ? `${outcome?.hostname ?? identity.hostname} is switched off in Settings → Forges, so its visibility was not re-read.`
          : outcome?.status === "signed_out"
            ? "Sign in to the forge in Settings → Forges, then refresh visibility again."
            : unresolved
              ? "Visibility is still unknown. Check Settings → Forges or Logs."
              : "Repository visibility refreshed.";
      setFeedback(message);
      const subject = { repoId };
      if (!result.ok || unresolved) {
        showErrorToast({ title: "Repository visibility", message, subject });
      } else {
        showInfoToast({ title: "Repository visibility", message, subject });
      }
    } catch {
      const message = "Could not refresh visibility. Check Settings → Forges or Logs.";
      setFeedback(message);
      showErrorToast({
        title: "Repository visibility",
        message,
        subject: { repoId }
      });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // Every mark in this row speaks through one card rather than a `title`.
  // `ForgeChip` beside them still uses a native title and shows one; these
  // 12px marks did not, and a bare `title` could not satisfy the Escape rule
  // `lib/AGENTS.md` puts on hover surfaces anyway. The refresh button three
  // sections down this same row already did it this way.
  //
  // Dropping the `title` costs a screen reader nothing: the row's
  // `aria-describedby` carries `identityDescription`, which states the fork
  // lineage and the read-only fact in words.
  const tip = useViewportTooltip();
  const parent = identity.parent;
  const visibilityTip = busy
    ? "Refreshing repository visibility…"
    : `${visibilityTitle(identity.visibility, identity.hostname)}. ${feedback ?? "Click to refresh visibility."}`;
  return (
    <>
      {/* A button once there is somewhere to go. It stated a problem and
          offered no way out of it, which sent people hunting through REMOTES
          for a verb that lived only in the worktree header. */}
      <NoPushMark
        identity={identity}
        {...(onFork === undefined ? {} : { onFork })}
      />
      {parent !== undefined && (() => {
        // Built inside the guard rather than above it: an ungated version
        // needed an empty-string fallback, and an `aria-label=""` on a
        // `role="img"` is an unnamed image — worse than no mark at all.
        const lineage = `Fork of ${parent.nameWithOwner}${
          identity.root === undefined
            ? ""
            : ` (originally ${identity.root.nameWithOwner})`
        }`;
        return (
          <span
            className="repo-mark repo-mark--fork"
            role="img"
            aria-label={lineage}
            {...hoverTooltip(tip, lineage)}
          >
            <GitForkIcon size={12} />
          </span>
        );
      })()}
      <button
        type="button"
        className={`repo-mark repo-mark--refresh repo-mark--${identity.visibility}`}
        // State first, then the action. The name used to be the action alone,
        // which said nothing about the repository it is on — the visibility
        // itself lived in a `title` that never rendered. SC 4.1.2 wants the
        // action named; nothing stops the name from also saying what it is
        // about, and it is the only place this control states it.
        aria-label={`${visibilityTitle(
          identity.visibility,
          identity.hostname
        )}. Refresh repository visibility`}
        aria-busy={busy}
        /* Busy is `aria-disabled`, never `disabled`: Chromium blurs an element
           the moment it becomes disabled, so a refresh started from the
           keyboard threw focus to <body> until it returned (SC 2.4.3) — the
           same fix `.ref-fetch-all` and `.wt-refresh` already carry. (Not
           because a disabled control swallows hover — it does not; Chromium
           still fires mouseover/enter on a disabled button, and only the
           click-shaped events are suppressed. See lib/AGENTS.md.) */
        aria-disabled={busy}
        {...hoverTooltip(tip, visibilityTip)}
        onClick={(event) => {
          event.stopPropagation();
          if (busy) return;
          tip.hide();
          void refresh();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <VisibilityIcon visibility={identity.visibility} size={12} />
      </button>
      {tip.tooltipNode}
      {feedback !== null && (
        <span className="a11y-sr-only" role="status">{feedback}</span>
      )}
    </>
  );
}

/**
 * The detail variant: labelled pills, for the clone and fork dialogs, where
 * there is room to spell every axis out. Public is stated here — a list can
 * be quiet about it, but a dialog you are about to act in should not be.
 */
export function RepoIdentityChips({
  repository
}: {
  repository: CloneRepository;
}) {
  const noPush = pushAccessTitle(repository);
  // One card for the row of pills, the same way the glyph variant above does
  // it. These pills are wider than a 12px mark and a `title` did render on
  // them — but it rendered for the pointer only, and this dialog is one a
  // keyboard user tabs through.
  const tip = useViewportTooltip();
  return (
    <>
      <span
        className="clone-chip clone-chip--muted"
        {...hoverTooltip(tip, `Hosted on ${repository.hostname}`)}
      >
        {hostLabel(repository.host, repository.hostname)}
      </span>
      <span
        className={`clone-chip clone-chip--vis clone-chip--${repository.visibility}`}
        {...hoverTooltip(
          tip,
          visibilityTitle(repository.visibility, repository.hostname)
        )}
      >
        <VisibilityIcon visibility={repository.visibility} size={10} />
        {VISIBILITY_LABEL[repository.visibility]}
      </span>
      {noPush !== null && (
        <span
          className="clone-chip clone-chip--nopush"
          {...hoverTooltip(tip, noPush)}
        >
          <NoPushIcon size={10} />
          read-only
        </span>
      )}
      {repository.parent !== undefined && (
        <span
          className="clone-chip clone-chip--muted clone-chip--fork"
          {...hoverTooltip(
            tip,
            `Fork of ${repository.parent.nameWithOwner}${
              repository.root === undefined
                ? ""
                : ` (originally ${repository.root.nameWithOwner})`
            }`
          )}
        >
          <GitForkIcon size={10} />
          {repository.parent.nameWithOwner}
        </span>
      )}
      {tip.tooltipNode}
    </>
  );
}

/** A screen-reader sentence for one repository's identity. The glyphs above
 *  are also described here independently of the visibility refresh button. */
export function identityDescription(identity: RepoIdentity): string {
  const parts = [
    identity.visibility === "unknown"
      ? "visibility unknown"
      : identity.visibility,
    `on ${identity.hostname}`
  ];
  // The forge chip beside the name is `aria-hidden`, so its `+n` reaches
  // nobody using a screen reader unless the same fact is spelled out here.
  // Origin's own host is already named above; only the others add anything.
  const others = (identity.remoteHostnames ?? []).filter(
    (hostname) => hostname !== identity.hostname
  );
  if (others.length > 0) {
    parts.push(`also has remotes on ${others.join(", ")}`);
  }
  if (identity.viewerCanPush === false) parts.push("read-only, you cannot push");
  if (identity.parent !== undefined) {
    parts.push(`fork of ${identity.parent.nameWithOwner}`);
  }
  return parts.join(", ");
}
