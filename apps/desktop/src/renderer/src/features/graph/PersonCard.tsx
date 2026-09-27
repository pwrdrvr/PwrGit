import {
  forgeLabel,
  type Commit,
  type CommitAuthorPerson
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { CopyTarget } from "../shell/CopyTarget";
import { AuthorAvatar } from "./AuthorAvatar";
import { CopyIcon } from "./CommitContextCard";
import { longWhen } from "./graph-view";

/** One author's footprint in the commits the graph has loaded. */
export type PersonGraphStats = {
  /** Their commits among `total`. */
  count: number;
  /** Every commit the graph has loaded — the window, not the repository. */
  total: number;
  /** Their newest loaded commit. */
  latest: Commit;
  /** Local branches whose tip is one of their commits. */
  tips: string[];
};

const MAX_TIPS = 2;

function OpenIcon() {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/** The one line that says what the forge knows, and how PwrGit knows it. */
export function personStatus(person: CommitAuthorPerson | undefined): {
  text: string;
  proven: boolean;
} {
  const forge = person?.forge === undefined ? undefined : forgeLabel(person.forge);
  switch (person?.state) {
    case "proven":
      return { text: `${forge ?? "Forge"} account, proven by a commit`, proven: true };
    case "none":
      return {
        text: `${forge ?? "The forge"} links these commits to no account`,
        proven: false
      };
    case "unsupported":
      return {
        text: forge === undefined
          ? "This repository's remote has no accounts to check"
          : `${forge} can't link commits to accounts`,
        proven: false
      };
    default:
      return {
        text: forge === undefined ? "Not checked yet" : `Not checked with ${forge} yet`,
        proven: false
      };
  }
}

/**
 * The person behind a commit byline. Renders purely from what the graph
 * already holds — its loaded commits, and the person main's store pushed —
 * and issues no request of its own, exactly like `PrStatusCard`. The login,
 * photo and profile link appear together or not at all: never a handle
 * without the proof behind it.
 */
export function PersonCard({
  name,
  email,
  isMine,
  person,
  stats,
  now
}: {
  /** The Git author name on their newest loaded commit. */
  name: string;
  email: string;
  isMine: boolean;
  person: CommitAuthorPerson | undefined;
  stats: PersonGraphStats;
  now: number;
}) {
  const displayName = name.trim() || "Unknown author";
  const identity = person?.state === "proven" ? person.identity : undefined;
  const status = personStatus(person);
  const profileUrl = identity === undefined ? undefined : person?.profileUrl;
  const forge = person?.forge === undefined ? "forge" : forgeLabel(person.forge);
  const shownTips = stats.tips.slice(0, MAX_TIPS);
  const moreTips = stats.tips.length - shownTips.length;
  const coAuthor = `Co-authored-by: ${displayName} <${email}>`;
  // You don't co-author yourself, and a line with no address credits no one.
  const canCoAuthor = !isMine && email !== "";

  return (
    <>
      <div className="person-card__header">
        <span className="person-card__eyebrow">
          {isMine ? "Author · you" : "Author"}
        </span>
        {identity !== undefined && (
          <span className="person-card__login">@{identity.login}</span>
        )}
      </div>

      <div className="person-card__identity">
        <AuthorAvatar
          block="person-card__avatar"
          name={displayName}
          avatarUrl={identity?.avatarUrl}
          size={40}
        />
        <span className="person-card__who">
          <strong className="person-card__name">{displayName}</strong>
          {email !== "" && (
            <span className="person-card__email">
              <span className="person-card__email-text">{email}</span>
              <CopyTarget
                value={email}
                label="Copy email address"
                hint={`Copy ${email}`}
                className="person-card__copy copyable"
              >
                <CopyIcon />
              </CopyTarget>
            </span>
          )}
        </span>
      </div>

      <div
        className={`person-card__status${status.proven ? "" : " is-muted"}`}
      >
        <span className="person-card__dot" aria-hidden="true" />
        {status.text}
      </div>

      <div className="person-card__section">
        <span className="person-card__section-title">In this graph</span>
        <div className="person-card__row">
          <span className="person-card__row-label">Commits</span>
          <span className="person-card__row-value">
            {stats.count} of {stats.total} shown
          </span>
        </div>
        <div className="person-card__row">
          <span className="person-card__row-label">Latest</span>
          <span className="person-card__row-value">
            {longWhen(stats.latest.committedAt, now)} · {stats.latest.shortHash}
          </span>
        </div>
        {shownTips.length > 0 && (
          <div className="person-card__row">
            <span className="person-card__row-label">
              {stats.tips.length === 1 ? "Tip of" : "Tips of"}
            </span>
            <span className="person-card__row-value">
              {shownTips.join(", ")}
              {moreTips > 0 ? ` +${moreTips}` : ""}
            </span>
          </div>
        )}
      </div>

      {(canCoAuthor || profileUrl !== undefined) && (
        <div className="person-card__actions">
          {canCoAuthor && (
            <CopyTarget
              value={coAuthor}
              label={`Copy co-author line for ${displayName}`}
              hint={coAuthor}
              className="person-card__action"
            >
              <CopyIcon />
              Co-author line
            </CopyTarget>
          )}
          {profileUrl !== undefined && (
            <button
              type="button"
              className="person-card__action"
              onClick={() => {
                void dispatch("shell:openExternal", { url: profileUrl });
              }}
            >
              <OpenIcon />
              Open on {forge}
            </button>
          )}
        </div>
      )}
    </>
  );
}
