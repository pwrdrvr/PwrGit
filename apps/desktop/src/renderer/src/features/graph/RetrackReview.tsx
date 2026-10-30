import { useEffect, useState, type ReactNode } from "react";
import type {
  RetrackMove,
  RetrackReview as Review,
  TrackingOption
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { CheckGlyph } from "../../lib/CheckGlyph";
import { WarningGlyph } from "../../lib/WarningGlyph";

const commits = (n: number): string => `${n} ${n === 1 ? "commit" : "commits"}`;
const short = (hash: string): string => hash.slice(0, 7);
const repoOf = (option: TrackingOption): string => option.nameWithOwner ?? option.remote;

/** How the branch stands against the ref it would track. */
export type RetrackShape = "same" | "forward" | "ahead" | "diverged";

export function retrackShape(target: TrackingOption): RetrackShape {
  if (target.ahead === 0) return target.behind === 0 ? "same" : "forward";
  return target.behind === 0 ? "ahead" : "diverged";
}

/** One answer to "what happens to the tip": the move, and whether the old
 *  tip is kept on a new branch first. */
export type RetrackChoice = {
  key: "keep" | "move";
  move: RetrackMove;
  copy: boolean;
  title: string;
  detail: string;
};

/**
 * The choices a review offers, the safe one first. A fast-forward or a
 * same-commit change has none to make. Otherwise keeping the tip where it is
 * comes first, and the move names where the leaving commits remain — or, when
 * some are on no remote at all, keeps them on a new branch. No choice drops a
 * commit nothing else has.
 */
export function retrackChoices(review: Review): RetrackChoice[] {
  const { branch, target } = review;
  const shape = retrackShape(target);
  if (shape === "same" || shape === "forward") return [];
  if (review.checkout.kind === "elsewhere") return [];
  const keep: RetrackChoice = {
    key: "keep",
    move: "none",
    copy: false,
    title: shape === "ahead" ? "Keep them on " + branch : `Track it, leave ${branch} where it is`,
    detail:
      shape === "ahead"
        ? `${branch} stays at ${short(review.head)} and is ↑${target.ahead} against ${target.ref}. Your next Push offers them to ${repoOf(target)}.`
        : `${branch} is ↑${target.ahead} ↓${target.behind} against ${target.ref}. Rebase or merge whenever you're ready.`
  };
  const verb = shape === "ahead" ? `Move ${branch} back to ${target.ref}` : `Move ${branch} to ${target.ref}`;
  const move: RetrackChoice =
    review.unpushed > 0
      ? {
          key: "move",
          move: "reset",
          copy: true,
          title: `${verb}, keep a copy`,
          detail: `Your ${review.unpushed === 1 ? "commit stays" : `${review.unpushed} commits stay`} on a new branch, ${review.copyName}, at ${short(review.head)}.`
        }
      : {
          key: "move",
          move: "reset",
          copy: false,
          title: verb,
          detail:
            review.leavingOn !== null
              ? `The ${commits(target.ahead)} leave ${branch} and remain on ${review.leavingOn}.`
              : `The ${commits(target.ahead)} leave ${branch} and remain on other fetched branches.`
        };
  return [keep, move];
}

/** The git the change runs, for the footer — the same words the log gets. */
export function retrackCommand(review: Review, choice: RetrackChoice | null): string {
  const { branch, target } = review;
  const parts: string[] = [];
  const move = choice?.move ?? (retrackShape(target) === "forward" ? "forward" : "none");
  if (choice?.copy === true) parts.push(`git branch ${review.copyName} ${branch}`);
  if (move === "forward" && review.checkout.kind !== "elsewhere") {
    parts.push(
      review.checkout.kind === "here"
        ? `git merge --ff-only ${short(target.head)}`
        : `git update-ref refs/heads/${branch} ${short(target.head)}`
    );
  } else if (move === "reset") {
    parts.push(
      review.checkout.kind === "here"
        ? `git reset --keep ${short(target.head)}`
        : `git update-ref refs/heads/${branch} ${short(target.head)}`
    );
  }
  parts.push(`git branch --set-upstream-to=${target.ref} ${branch}`);
  return parts.join(" · ");
}

function Fact({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }) {
  return (
    <li className={`retrack__fact retrack__fact--${tone}`}>
      <span className="retrack__fact-mark" aria-hidden="true">
        {tone === "ok" ? <CheckGlyph size={11} /> : <WarningGlyph size={12} />}
      </span>
      <span>{children}</span>
    </li>
  );
}

export type RetrackDone = {
  branch: string;
  ref: string;
  moved: boolean;
  copied: string | null;
  arrived: number;
};

/**
 * The switcher's second step: what tracking `remote/remoteBranch` would do to
 * `branch`, asked inside the same overlay. Back returns to the list.
 * Design: `design/Tracking Another Remote - UX Review.dc.html`, turn 3.
 */
export function RetrackReview({
  worktreeId,
  branch,
  remote,
  remoteBranch,
  onBack,
  onDone
}: {
  worktreeId: string;
  branch: string;
  remote: string;
  remoteBranch: string;
  onBack: () => void;
  onDone: (done: RetrackDone) => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<"keep" | "move">("keep");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setReview(null);
    setError(null);
    void dispatch("remote:inspectRetrack", { worktreeId, branch, remote, remoteBranch }).then(
      (result) => {
        if (!active) return;
        if (result.ok) setReview(result.value);
        else setError(result.error.message);
      }
    );
    return () => {
      active = false;
    };
  }, [worktreeId, branch, remote, remoteBranch]);

  const label = `${remote}/${remoteBranch}`;
  const choices = review === null ? [] : retrackChoices(review);
  const choice = choices.find((c) => c.key === pick) ?? null;

  const confirm = async (): Promise<void> => {
    if (review === null || busy) return;
    const shape = retrackShape(review.target);
    const move: RetrackMove =
      choice?.move ??
      (shape === "forward" && review.checkout.kind !== "elsewhere" ? "forward" : "none");
    setBusy(true);
    setError(null);
    const result = await dispatch("remote:retrack", {
      worktreeId,
      branch: review.branch,
      remote: review.target.remote,
      remoteBranch: review.target.remoteBranch,
      head: review.head,
      targetHead: review.target.head,
      upstreamRef: review.upstreamRef,
      move,
      ...(choice?.copy === true ? { copy: review.copyName } : {})
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onDone({
      branch: review.branch,
      ref: review.target.ref,
      moved: result.value.moved,
      copied: result.value.copied,
      arrived: result.value.moved && move !== "none" ? review.target.behind : 0
    });
  };

  const header = (
    <div className="retrack__head">
      <button
        type="button"
        className="retrack__back"
        aria-label="Back to branches (Esc)"
        title="Back to branches (Esc)"
        onClick={onBack}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <span className="retrack__title">
        Track <code>{label}</code> for <code>{branch}</code>
      </span>
    </div>
  );

  if (review === null) {
    return (
      <>
        {header}
        <div className={error === null ? "overlay-empty" : "overlay-foot overlay-foot--error"}>
          {error ?? "Reading both branches…"}
        </div>
      </>
    );
  }

  const { target, from, checkout } = review;
  const shape = retrackShape(target);
  const moving =
    choice !== null
      ? choice.move !== "none"
      : shape === "forward" && checkout.kind !== "elsewhere";
  const cta =
    shape === "forward" && checkout.kind !== "elsewhere"
      ? "Track and fast-forward"
      : choice === null || choice.move === "none"
        ? shape === "ahead"
          ? "Track and keep my commits"
          : `Track ${label}`
        : choice.copy
          ? `Keep a copy and move ${branch}`
          : `Track and move ${branch}`;

  const leaving =
    target.ahead === 0 ? (
      <div className="reset-ledger__cell">
        <strong>0</strong>
        <span>
          {shape === "forward" ? `commits leave ${branch}. It has none of its own.` : `commits leave ${branch}`}
        </span>
      </div>
    ) : review.unpushed > 0 ? (
      <div className="reset-ledger__cell is-hot">
        <strong>{target.ahead}</strong>
        <span>
          {target.ahead === review.unpushed
            ? `${target.ahead === 1 ? "commit exists" : "commits exist"} only on this machine. ${target.ahead === 1 ? "It is" : "They are"} on no remote.`
            : `on ${branch} that ${target.ref} doesn't have · ${review.unpushed} on no remote`}
        </span>
      </div>
    ) : (
      <div className="reset-ledger__cell is-warn">
        <strong>{target.ahead}</strong>
        <span>
          {`on ${branch} that ${target.ref} doesn't have. `}
          {review.leavingOn !== null
            ? `${target.ahead === 1 ? "It is" : target.ahead === 2 ? "Both are" : "All are"} on ${review.leavingOn}.`
            : "They are on other fetched branches."}
        </span>
      </div>
    );
  const arriving = (
    <div className={`reset-ledger__cell${target.behind > 0 ? " is-good" : ""}`}>
      <strong>{target.behind}</strong>
      <span>
        {target.behind === 0
          ? shape === "same"
            ? `arrive. Already at ${short(target.head)}.`
            : `arrive. ${target.ref} is behind ${branch}.`
          : shape === "forward"
            ? `${target.behind === 1 ? "commit arrives" : "commits arrive"} · fast-forward to ${short(target.head)}`
            : `on ${target.ref} that ${branch} doesn't have`}
      </span>
    </div>
  );

  const pushFact =
    review.pushOverride !== null ? (
      <Fact tone="warn">
        Pull comes from <b>{repoOf(target)}</b>, but Push for <code>{branch}</code> still goes to{" "}
        <b>{review.pushOverride.remote}</b> (<code>{review.pushOverride.key}</code>).
      </Fact>
    ) : target.canPush === false ? (
      <Fact tone="warn">
        You can't push to <b>{repoOf(target)}</b>. Pull would come from there, and Push for{" "}
        <code>{branch}</code> would be refused until you track a fork.
      </Fact>
    ) : (
      <Fact tone="ok">
        Pull and Push for <code>{branch}</code> go to <b>{repoOf(target)}</b> from now on.
      </Fact>
    );
  const checkoutFact =
    checkout.kind === "elsewhere" ? (
      <Fact tone="warn">
        <code>{branch}</code> is checked out at <code>{checkout.path}</code>, so only its tracking
        changes here. Pull there to bring {target.behind > 0 ? commits(target.behind) : "it"} in.
      </Fact>
    ) : checkout.kind === "free" ? (
      <Fact tone="ok">Then this worktree switches to <code>{branch}</code>.</Fact>
    ) : !moving ? (
      <Fact tone="ok">Nothing in the worktree changes.</Fact>
    ) : checkout.dirty === 0 ? (
      <Fact tone="ok">The worktree is clean, so nothing else moves.</Fact>
    ) : (
      <Fact tone="ok">
        {checkout.dirty} uncommitted {checkout.dirty === 1 ? "file stays" : "files stay"} where{" "}
        {checkout.dirty === 1 ? "it is" : "they are"}. If one would be overwritten, nothing changes.
      </Fact>
    );

  return (
    <>
      {header}
      <div className="retrack__body">
        <div className="retrack__route">
          <div className="retrack__stop">
            <span className="retrack__stop-kind">tracks now</span>
            <span className="retrack__stop-ref">{from?.ref ?? "nothing"}</span>
            {from !== null && <span className="retrack__stop-repo">{repoOf(from)}</span>}
          </div>
          <span className="retrack__arrow" aria-hidden="true">→</span>
          <div className="retrack__stop retrack__stop--to">
            <span className="retrack__stop-kind">will track</span>
            <span className="retrack__stop-ref">{target.ref}</span>
            <span className="retrack__stop-repo">{repoOf(target)}</span>
          </div>
        </div>
        <div className="reset-ledger retrack__ledger">
          {leaving}
          {arriving}
        </div>
        {shape === "forward" && review.arriving.length > 0 && (
          <ul className="retrack__commits">
            {review.arriving.map((commit) => (
              <li key={commit.hash}>
                <span className="retrack__hash">{short(commit.hash)}</span>
                <span className="retrack__subject">{commit.subject}</span>
              </li>
            ))}
            {target.behind > review.arriving.length && (
              <li className="retrack__more">and {target.behind - review.arriving.length} more</li>
            )}
          </ul>
        )}
        {choices.length > 0 && (
          <div className="retrack__choices" role="radiogroup" aria-label={`What happens to ${branch}`}>
            {choices.map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={c.key === pick}
                className={`retrack__choice${c.key === pick ? " is-on" : ""}`}
                onClick={() => setPick(c.key)}
              >
                <span className="retrack__radio" aria-hidden="true" />
                <span>
                  <span className="retrack__choice-title">{c.title}</span>
                  <span className="retrack__choice-detail">{c.detail}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <ul className="retrack__facts">
          {pushFact}
          {checkoutFact}
        </ul>
      </div>
      {error !== null && <div className="overlay-foot overlay-foot--error">{error}</div>}
      <div className="retrack__foot">
        <span className="retrack__cmd" title={retrackCommand(review, choice)}>
          {retrackCommand(review, choice)}
        </span>
        <button type="button" className="modal__cancel" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="modal__create"
          aria-disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? "Changing…" : cta}
        </button>
      </div>
    </>
  );
}
