import { useRef, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
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
 * The dense variant: glyphs only, for the 320px sidebar. The parent slug has
 * nowhere to go at this width, so it lives in the title — the row already
 * relies on titles for the same reason its name does (SC 1.4.4).
 */
export function RepoIdentityGlyphs({
  identity,
  repoId,
  profileId
}: {
  identity: RepoIdentity;
  repoId: string;
  profileId: string;
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
      if (!result.ok || unresolved) {
        showErrorToast({ title: "Repository visibility", message });
      } else {
        showInfoToast({ title: "Repository visibility", message });
      }
    } catch {
      const message = "Could not refresh visibility. Check Settings → Forges or Logs.";
      setFeedback(message);
      showErrorToast({ title: "Repository visibility", message });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {identity.parent !== undefined && (
        <span
          className="repo-mark repo-mark--fork"
          title={`Fork of ${identity.parent.nameWithOwner}${
            identity.root === undefined
              ? ""
              : ` (originally ${identity.root.nameWithOwner})`
          }`}
        >
          <GitForkIcon size={12} />
        </span>
      )}
      <button
        type="button"
        className={`repo-mark repo-mark--refresh repo-mark--${identity.visibility}`}
        title={busy
          ? "Refreshing repository visibility…"
          : `${visibilityTitle(identity.visibility, identity.hostname)}. ${feedback ?? "Click to refresh visibility."}`
        }
        aria-label="Refresh repository visibility"
        aria-busy={busy}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          void refresh();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <VisibilityIcon visibility={identity.visibility} size={12} />
      </button>
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
  return (
    <>
      <span
        className="clone-chip clone-chip--muted"
        title={`Hosted on ${repository.hostname}`}
      >
        {hostLabel(repository.host, repository.hostname)}
      </span>
      <span
        className={`clone-chip clone-chip--vis clone-chip--${repository.visibility}`}
        title={visibilityTitle(repository.visibility, repository.hostname)}
      >
        <VisibilityIcon visibility={repository.visibility} size={10} />
        {VISIBILITY_LABEL[repository.visibility]}
      </span>
      {repository.parent !== undefined && (
        <span
          className="clone-chip clone-chip--muted clone-chip--fork"
          title={`Fork of ${repository.parent.nameWithOwner}${
            repository.root === undefined
              ? ""
              : ` (originally ${repository.root.nameWithOwner})`
          }`}
        >
          <GitForkIcon size={10} />
          {repository.parent.nameWithOwner}
        </span>
      )}
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
  if (identity.parent !== undefined) {
    parts.push(`fork of ${identity.parent.nameWithOwner}`);
  }
  return parts.join(", ");
}
