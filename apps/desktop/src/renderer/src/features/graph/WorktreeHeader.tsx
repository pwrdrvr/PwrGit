import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  PushPublishTarget,
  PwrGitError,
  RemoteDivergence,
  RemoteEndpoint,
  Repo,
  Result,
  SshRemoteRecovery,
  Worktree,
  WorktreeState
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { PullGlyph } from "../../lib/PullGlyph";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { showErrorToast } from "../../lib/toast";
import {
  remoteActivityPhaseLabel,
  type RemoteActivityScope
} from "../remote/remote-activity";
import { useRemoteActivityPopover } from "../remote/useRemoteActivityPopover";
import { useRemoteActivityFor } from "../../state/useRemoteActivity";
import { WorktreeMenu } from "../shell/WorktreeMenu";
import { GitLfsChip } from "./GitLfsChip";
import { PullDivergenceDialog } from "./PullDivergenceDialog";
import { openResetToRemote } from "./reset-to-remote";
import { SshRemoteRecoveryDialog } from "./SshRemoteRecoveryDialog";
import { ForkCheckoutDialog } from "../sidebar/ForkCheckoutDialog";
import { PublishBranchDialog } from "./PublishBranchDialog";
import { pushAccessTitle } from "../sidebar/RepoIdentityMarks";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

type Chip = { text: string; tone: "muted" | "ok" | "warn" };

function baseChip(state: WorktreeState | null, worktree: Worktree): Chip {
  // A gone checkout outranks every sync reading: nothing below is true of a
  // directory that does not exist. Read it from this worktree's own row when
  // the live snapshot still belongs to the previous selection.
  const missing =
    state?.worktreeId === worktree.id ? state.missing : worktree.missing;
  if (missing === true) return { text: "directory missing", tone: "warn" };
  if (state === null) return { text: "…", tone: "muted" };
  if (state.behind > 0) {
    const ahead = state.ahead > 0 ? ` · ↑${state.ahead}` : "";
    return { text: `↓${state.behind} behind${ahead}`, tone: "warn" };
  }
  if (state.ahead > 0) return { text: `↑${state.ahead} ahead`, tone: "ok" };
  if (!state.hasUpstream) return { text: "no upstream", tone: "muted" };
  return { text: "up to date", tone: "muted" };
}

/**
 * How far the repo's default branch has moved on without this branch — the
 * `main +4` chip. Not a sync state: pulling won't change it, which is why it
 * reads quieter than the sync chip and never takes the warn rung.
 *
 * The five fields are read from ONE source — mixing them can pair a fresh count
 * with a stale branch name, and the whole point of the chip is naming which
 * branch the count belongs to. That source is the live snapshot only when it is
 * *this* worktree's: `useWorktreeState` keeps the previous selection's snapshot
 * until the new `worktree:getState` resolves, and unlike a stale ↓behind count,
 * a stale drift chip states something false about the branch on screen ("main
 * has 4 commits not in <the branch you just navigated away from>").
 *
 * `null` when there's nothing to say: on the default branch itself, once the
 * work is contained in it, or with no shared history (count is 0 anyway).
 */
function defaultBranchDrift(
  state: WorktreeState | null,
  worktree: Worktree
): { text: string; title: string } | null {
  const s = state?.worktreeId === worktree.id ? state : worktree;
  if (s.isDefaultBranch || s.mergedIntoDefault || s.divergedFromDefault) {
    return null;
  }
  if (s.behindDefault <= 0) return null;
  const defaultBranch = s.defaultBranch || "default branch";
  return {
    text: `${defaultBranch} +${s.behindDefault}`,
    title: `${defaultBranch} has ${s.behindDefault} commits not in ${s.branch}; this is not commits available to pull`
  };
}

type Busy = "fetch" | "pull" | "push" | null;

/**
 * Hover/focus handlers shared by the sync chip and the action buttons.
 *
 * Structural rather than `ComponentProps<"button">`, and `currentTarget` is
 * all the popover needs to anchor itself. The chip builds the same shape
 * inline: it is not focusable and cannot be tabbed out of, so it takes only
 * the pointer half, and `ref` here is typed for the buttons this factory
 * actually spreads onto.
 */
type StatusTriggerProps = {
  /** Only ever on the one busy button, so one ref serves all three: it is how
   * the popover finds the button when no event announces it. */
  ref?: RefObject<HTMLButtonElement | null>;
  onMouseEnter?: (event: { currentTarget: HTMLElement }) => void;
  onMouseLeave?: () => void;
  onFocus?: (event: { currentTarget: HTMLElement }) => void;
  onBlur?: () => void;
  onKeyDown?: (event: {
    key: string;
    shiftKey: boolean;
    preventDefault: () => void;
  }) => void;
};
type RecoveryBusy = "rebase" | "reset" | null;

export function WorktreeHeader({
  repo,
  worktree,
  state
}: {
  /** `profileId` and `identity` are here for the fork prompt: the first is
   *  what the fork command is scoped to, the second is what says this checkout
   *  cannot be pushed to. */
  repo: Pick<Repo, "id" | "name" | "path" | "profileId" | "identity">;
  worktree: Worktree;
  state: WorktreeState | null;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [divergence, setDivergence] = useState<RemoteDivergence | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<RecoveryBusy>(null);
  /** The HTTPS → SSH offer, and which operation Git refused for want of a
   *  credential — the dialog's copy is about that operation. */
  const [sshRecovery, setSshRecovery] = useState<{
    operation: Exclude<Busy, null>;
    recovery: SshRemoteRecovery;
  } | null>(null);
  /** The fork prompt, and why it opened. `{}` is the user asking for it from
   *  the read-only chip; a `reason` is a push the forge just refused. */
  const [forkPrompt, setForkPrompt] = useState<{ reason?: string } | null>(null);
  /** The remotes a branch with no upstream can be published to, while the
   *  question is open. Loaded BEFORE the dialog opens, so its list never
   *  arrives under a dialog the user is already reading. */
  const [publishing, setPublishing] = useState<RemoteEndpoint[] | null>(null);
  /** The Push button as it was clicked, so a card can hang off it once the
   *  publish question has been answered. A ref rather than the trigger
   *  factory's `cardButton`, which only points at a button while it carries
   *  a card. */
  const pushTarget = useRef<HTMLElement | null>(null);
  /** The publish question being loaded, if any. A token rather than a flag:
   *  switching checkouts clears it, so a load from an earlier visit finds
   *  itself superseded even when the user has come back to the same one. */
  const askingWhere = useRef<symbol | null>(null);
  const tip = useViewportTooltip();
  const [flash, setFlash] = useState<Chip | null>(null);
  const activeWorktreeId = useRef(worktree.id);
  /** Bumped by every Fetch, Pull and Push this header starts, and by every
   *  change of checkout. `activeWorktreeId` alone cannot tell an outcome from
   *  an earlier visit apart from one of the same checkout's now, and an
   *  outcome arriving after the user has come back and started something else
   *  would settle — or dismiss — that newer operation's card. */
  const remoteOperation = useRef(0);
  const recoveryInFlight = useRef<string | null>(null);
  const recoveryOperation = useRef(0);
  const cardButton = useRef<HTMLButtonElement>(null);
  const cardChip = useRef<HTMLSpanElement>(null);

  // Header instances stay mounted while selection changes, so an operation
  // started for one worktree must never surface a dialog or flash on another.
  useEffect(() => {
    activeWorktreeId.current = worktree.id;
    remoteOperation.current += 1;
    recoveryOperation.current += 1;
    recoveryInFlight.current = null;
    setBusy(null);
    setDivergence(null);
    setRecoveryBusy(null);
    setSshRecovery(null);
    setForkPrompt(null);
    setPublishing(null);
    askingWhere.current = null;
  }, [worktree.id]);

  // Phase, Git's output and the cancel all ride on one live record, scoped to
  // this checkout: an operation started in another repository never reports
  // itself here (it surfaces in the toast instead).
  const activity = useRemoteActivityFor(worktree.id);
  // The two controls the card hangs from. An operation can start under a
  // pointer that never moves — pressing Fetch is the plain case — and then no
  // enter event announces the trigger, so the popover reads these instead.
  // Button first: it is the thing the user aimed at.
  const status = useRemoteActivityPopover(activity, [cardButton, cardChip]);

  // The selection changed under a pinned card. That card reports an operation
  // belonging to a checkout that is no longer on screen, and its dispatch will
  // come back to one of the staleness guards below rather than to a `settle` —
  // so this is the only thing that can ever take it away. Without it the card
  // stands on "Starting…" over the new worktree's toolbar, titled with the old
  // one's repository, until the user clicks it off.
  //
  // Its own effect rather than a line in the reset above, because that one is
  // declared before the hook that owns `dismiss`.
  useEffect(() => {
    status.dismiss();
  }, [status.dismiss, worktree.id]);

  const showFlash = (chip: Chip, ms: number): void => {
    setFlash(chip);
    setTimeout(() => setFlash(null), ms);
  };

  /**
   * Every path out of an operation ends in exactly one of three things: the
   * card settles into a receipt, the card is dismissed because a modal is
   * taking over, or — for a failure the card could not carry — a toast. Adding
   * a fourth early return without one of them leaves a card pinned on
   * "Starting…" until the user clicks it away.
   */

  /** Who an operation belongs to, for the card that outlives its record. */
  const scopeOf = (kind: Exclude<Busy, null>): RemoteActivityScope => ({
    kind,
    repoName: repo.name,
    branch: worktree.branch
  });

  /**
   * Open the status card for the operation this click is about to start.
   *
   * Before the dispatch, not after: the card is the answer to "what is it
   * doing?", and the gap between pressing the button and main registering the
   * operation is exactly the stretch where that question has had no answer.
   */
  const pinStatus = (
    kind: Exclude<Busy, null>,
    target: HTMLElement
  ): void => {
    status.pin(target, scopeOf(kind));
  };

  // Failures surface twice on purpose: the inline chip flash (collapsed away
  // in narrow headers) AND an error toast, which is visible at any width and
  // links to the Logs window.
  //
  // A cancel takes neither. The user stopped it themselves a second ago and
  // is watching the button they pressed; dressing their own decision as a
  // failure card is noise, and an error toast would outlive the gesture.
  const flashError = (
    kind: string,
    error: PwrGitError,
    { onCard = true }: { onCard?: boolean } = {}
  ): void => {
    if (error.code === "canceled") {
      showFlash({ text: `${kind.toLowerCase()} canceled`, tone: "muted" }, 2000);
      if (onCard) status.settle({ status: "canceled", summary: `${kind} canceled` });
      return;
    }
    const firstLine = error.message.split("\n")[0];
    // What the tool wrote, when the message is PwrGit's reading of it.
    const detail = error.detail ?? error.message;
    showFlash({ text: firstLine.slice(0, 64), tone: "warn" }, 3200);
    // The status card is durable on a failure, anchored to the button that was
    // pressed, and carries Git's own output plus Logs and Copy. A corner toast
    // saying the same thing at the same time is noise — so it is the fallback
    // for a failure with no card to land on, which is what `settle` reports.
    const carried =
      onCard &&
      status.settle({
        status: "error",
        summary: `${kind} failed — ${firstLine}`,
        detail
      });
    if (carried) return;
    showErrorToast({
      title: `${kind} failed`,
      message: firstLine,
      detail,
      subject: { repoId: repo.id }
    });
  };

  /**
   * Start counting one Fetch, Pull or Push. The returned guard answers whether
   * its outcome still belongs on screen: the same checkout, and nothing started
   * since (see `remoteOperation`).
   */
  const beginOperation = (worktreeId: string): (() => boolean) => {
    const operation = ++remoteOperation.current;
    return () =>
      activeWorktreeId.current === worktreeId &&
      remoteOperation.current === operation;
  };

  /**
   * Offer to switch the remote from HTTPS to SSH after Git refused `kind` for
   * want of a credential it may not prompt for.
   *
   * `true` means the operation needs nothing more from its caller: the dialog
   * took over (and, being modal, took the card with it — the same rule as the
   * divergence and fork prompts), or the operation was superseded while the
   * remote was inspected. `false` leaves the failure to the caller's own
   * error path — not an auth failure, or nothing to offer (not GitHub over
   * HTTPS, no upstream, a push that does not travel by that URL).
   *
   * `busy` is held through the inspect, as it is through Pull's divergence
   * inspect: the operation is not over until its outcome is known, and a
   * button that went idle here could start another one whose card this
   * dismisses.
   */
  const handOffToSshRecovery = async (
    kind: Exclude<Busy, null>,
    worktreeId: string,
    error: PwrGitError,
    current: () => boolean
  ): Promise<boolean> => {
    if (error.kind !== "remote" || error.code !== "authentication_required") {
      return false;
    }
    const inspected = await dispatch("remote:inspectSshRecovery", {
      worktreeId,
      operation: kind
    });
    // Superseded: the reset effect has already cleared `busy` and the card.
    if (!current()) return true;
    if (!inspected.ok || inspected.value === null) return false;
    setBusy(null);
    status.dismiss();
    setSshRecovery({ operation: kind, recovery: inspected.value });
    return true;
  };

  const run = async (
    kind: Exclude<Busy, null>,
    fn: () => Promise<Result<unknown, PwrGitError>>,
    okChip: Chip,
    okSummary: string,
    label: string
  ): Promise<void> => {
    const worktreeId = worktree.id;
    // The same guard `onPull` and `onPush` carry, and now load-bearing for a
    // third reason: an outcome that settles the card of a checkout it does not
    // belong to puts one worktree's error under another's title — and reports
    // it as carried, so the toast that should have caught it never fires.
    // The reset effect above clears `busy` on the switch.
    const current = beginOperation(worktreeId);
    setBusy(kind);
    const result = await fn();
    if (!current()) return;
    if (
      !result.ok &&
      (await handOffToSshRecovery(kind, worktreeId, result.error, current))
    ) {
      return;
    }
    setBusy(null);
    if (result.ok) {
      showFlash(okChip, 1600);
      status.settle({ status: "ok", summary: okSummary });
      return;
    }
    flashError(label, result.error);
  };

  const id = worktree.id;
  const onFetch = (): void => {
    void run(
      "fetch",
      () => dispatch("remote:fetch", { worktreeId: id }),
      { text: "fetched", tone: "muted" },
      "Fetched — refs and tags are up to date",
      "Fetch"
    );
  };
  const onPull = (): void => {
    const worktreeId = id;
    const current = beginOperation(worktreeId);
    setBusy("pull");
    void dispatch("remote:pull", { worktreeId }).then(async (result) => {
      if (!result.ok) {
        if (
          result.error.kind === "remote" &&
          result.error.code === "not_fast_forward"
        ) {
          const inspected = await dispatch("remote:inspectDivergence", {
            worktreeId
          });
          if (!current()) return;
          setBusy(null);
          if (inspected.ok) {
            // The dialog IS the outcome, and it is modal: a status card left
            // pinned behind it would be a second thing to dismiss for one
            // pull, and would sit over the histories the dialog exists to
            // compare. Same rule as the fork prompt below.
            status.dismiss();
            setDivergence(inspected.value);
            return;
          }
        }
        if (!current()) return;
        if (await handOffToSshRecovery("pull", worktreeId, result.error, current)) {
          return;
        }
        setBusy(null);
        flashError("Pull", result.error);
        return;
      }
      if (!current()) return;
      setBusy(null);
      const { stashed, reappliedWithConflicts } = result.value;
      if (reappliedWithConflicts) {
        showFlash(
          { text: "pulled · resolve stash conflicts", tone: "warn" },
          4000
        );
        // Reported as a failure so the card stands until dismissed: there is
        // work left to do in the checkout, and a receipt that takes itself
        // away in four seconds is the wrong shape for that.
        status.settle({
          status: "error",
          summary: "Pulled — your stashed changes came back with conflicts"
        });
      } else if (stashed) {
        showFlash({ text: "pulled · changes reapplied", tone: "ok" }, 2400);
        status.settle({
          status: "ok",
          summary: "Fast-forwarded · local changes stashed and reapplied"
        });
      } else {
        showFlash({ text: "fast-forwarded", tone: "ok" }, 1600);
        status.settle({ status: "ok", summary: "Fast-forwarded" });
      }
    });
  };

  const recover = async (action: Exclude<RecoveryBusy, null>): Promise<void> => {
    if (divergence === null || recoveryInFlight.current !== null) return;
    const worktreeId = id;
    const operation = ++recoveryOperation.current;
    recoveryInFlight.current = worktreeId;
    setRecoveryBusy(action);
    const result = await dispatch(
      action === "rebase" ? "remote:rebaseOntoUpstream" : "remote:resetToUpstream",
      {
        worktreeId,
        branch: divergence.branch,
        head: divergence.head,
        upstreamHead: divergence.upstreamHead
      }
    );
    if (
      recoveryOperation.current !== operation ||
      activeWorktreeId.current !== worktreeId
    ) {
      return;
    }
    recoveryInFlight.current = null;
    setRecoveryBusy(null);
    if (!result.ok) {
      setDivergence(null);
      flashError(action === "rebase" ? "Rebase" : "Reset", result.error);
      return;
    }
    setDivergence(null);
    showFlash(
      {
        text: action === "rebase" ? "rebased onto remote" : "reset to remote",
        tone: "ok"
      },
      2400
    );
  };
  /**
   * Ask where a branch with no upstream should go.
   *
   * A plain `git push` there is a dead end — Git refuses and prints the
   * `--set-upstream` command for the user to go and run in a terminal — and
   * this toolbar already says "no upstream" in the chip beside the button.
   * Loads the remotes first and opens the dialog second, so nothing arrives
   * underneath a dialog the user has started reading.
   */
  const askWhereToPublish = async (): Promise<void> => {
    if (askingWhere.current !== null) return;
    const ask = Symbol("publish question");
    askingWhere.current = ask;
    const remotes = await dispatch("repo:remotes", { repoId: repo.id });
    if (askingWhere.current !== ask) return;
    askingWhere.current = null;
    if (!remotes.ok) {
      // Nothing of this question's is pinned — a card still up belongs to an
      // earlier operation, and settling would rewrite it as this failure.
      flashError("Push", remotes.error, { onCard: false });
      return;
    }
    setPublishing(remotes.value);
  };

  const onPush = (publish?: PushPublishTarget): void => {
    const worktreeId = id;
    const current = beginOperation(worktreeId);
    setBusy("push");
    void dispatch("remote:push", {
      worktreeId,
      ...(publish === undefined ? {} : { publish })
    }).then(async (result) => {
      if (!current()) return;
      if (
        !result.ok &&
        (await handOffToSshRecovery("push", worktreeId, result.error, current))
      ) {
        return;
      }
      setBusy(null);
      if (result.ok) {
        showFlash(
          {
            text:
              publish === undefined ? "pushed" : `published to ${publish.remote}`,
            tone: "ok"
          },
          1600
        );
        status.settle({
          status: "ok",
          summary:
            publish === undefined ? "Pushed" : `Published to ${publish.remote}`
        });
        return;
      }
      // No upstream after all: the state the button read was stale, or had not
      // been computed yet. The remedy is the same as reading it right, and a
      // card relaying Git's "go run --set-upstream" advice is not a remedy —
      // so the card goes, like the fork prompt's does, and the question opens.
      if (
        result.error.code === "no_upstream" &&
        publish === undefined &&
        worktree.branch !== null
      ) {
        status.dismiss();
        void askWhereToPublish();
        return;
      }
      // The one push failure with a remedy inside PwrGit. Git has just said
      // the account may not write there, which is better evidence than any
      // stored permission — so this path does not consult `identity`, and
      // works on a checkout nothing has ever asked the forge about.
      if (result.error.code === "push_denied") {
        showFlash({ text: "push denied", tone: "warn" }, 2400);
        // The fork prompt is a modal over the whole window; leaving a status
        // card behind it would be a second thing to dismiss for one refusal.
        status.dismiss();
        setForkPrompt({ reason: result.error.message.split("\n")[0] });
        return;
      }
      flashError("Push", result.error);
    });
  };

  // One sentence, defined beside the sidebar mark that also shows it.
  const noPushTitle =
    repo.identity === undefined ? null : pushAccessTitle(repo.identity);

  // What is running, from either side: `busy` covers this header's own
  // dispatch before main has registered it, the activity covers an operation
  // started somewhere else against the same checkout (the sidebar, a second
  // window). Either one makes the matching button busy.
  const running: Busy = busy ?? activity?.kind ?? null;
  const IDLE_LABEL = {
    fetch: "Fetching…",
    pull: "Pulling…",
    push: "Pushing…"
  } as const;
  // The phase alone, with no counter in it: the chip is a live region, and a
  // label carrying seconds would re-announce every second. The detail — how
  // long, how quiet, what Git last said — lives in the status popover.
  const busyLabel = (kind: Exclude<Busy, null>): string =>
    activity !== null && activity.kind === kind
      ? `${remoteActivityPhaseLabel(activity.phase)}…`
      : IDLE_LABEL[kind];
  const chip =
    running !== null
      ? { text: busyLabel(running), tone: "muted" as const }
      : (flash ?? baseChip(state, worktree));
  // Hovering the working control is how the status card is summoned, so the
  // handlers ride on whichever button this operation belongs to — and on the
  // progress chip beside them, which is the wider target and the thing a user
  // is already looking at when they wonder what it is doing.
  //
  // They go on from the first busy render, not from the record's arrival,
  // because clicking Pull leaves the pointer inside the button: the only
  // `mouseenter` that button will ever see fires when its glyph swaps for the
  // spinner, one or more renders before main reports the operation. A trigger
  // that is not listening yet at that moment loses the hover for good. The
  // popover holds a hover with nothing to report and opens when the record
  // lands (see useRemoteActivityPopover).
  //
  // Widened in time only, never in scope: `running` also answers to this
  // header's own `busy`, so a locally dispatched fetch can be what makes this
  // button busy while the live record for the same checkout is a pull started
  // somewhere else. Hanging that pull's card off the Fetch button would name
  // an operation this control has nothing to do with, so once a record exists
  // it still has to be this button's own.
  const carriesCard = (kind: Exclude<Busy, null>): boolean =>
    activity !== null && activity.kind === kind;
  // The same button, one step earlier: whatever already carries the card, plus
  // the gap before this operation has a record to carry.
  const couldCarryCard = (kind: Exclude<Busy, null>): boolean =>
    carriesCard(kind) || (running === kind && activity === null);
  const statusTrigger = (kind: Exclude<Busy, null>): StatusTriggerProps => {
    const carries = couldCarryCard(kind);
    // The pointer reaches Cancel by moving into the card; Tab is the
    // keyboard's equivalent, the same handoff `GraphRow` makes into the
    // commit context card. Without it Tab lands on Pull, blurs the trigger,
    // and takes the card away — leaving the one control that stops a wedged
    // fetch reachable by mouse only.
    //
    // It reaches past `carries` because a *pinned* card is anchored to
    // whichever button was clicked rather than to a trigger this factory
    // knows about — but only as far as that button. The three are adjacent
    // and carry `aria-disabled` rather than `disabled`, so they stay
    // tabbable while one of them works: claiming Tab on all of them would
    // send a keyboard user on Push backwards, past Push, into a card hanging
    // off Pull (SC 2.4.3).
    const handsOff = carries || status.pinnedKind === kind;
    return {
      ...(!carries
        ? {}
        : {
            ref: cardButton,
            onMouseEnter: (event: { currentTarget: HTMLElement }) =>
              status.open(event.currentTarget),
            onMouseLeave: status.close,
            onFocus: (event: { currentTarget: HTMLElement }) =>
              status.open(event.currentTarget),
            onBlur: status.close
          }),
      ...(!handsOff
        ? {}
        : {
            onKeyDown: (event: {
              key: string;
              shiftKey: boolean;
              preventDefault: () => void;
            }) => {
              if (
                event.key === "Tab" &&
                !event.shiftKey &&
                status.focusFirst()
              ) {
                event.preventDefault();
              }
            }
          })
    };
  };
  /**
   * A native tooltip everywhere the status card is NOT coming — the two must
   * never both appear, but a button with neither is worse than either.
   *
   * That is `carriesCard`, not `couldCarryCard`: in the gap before the record
   * arrives the button is already listening for the hover that will summon a
   * card, and the title is what covers exactly that gap. The two cannot
   * overlap on screen because the record that lets the card open is the same
   * record that drops this attribute, in one render.
   *
   * `status.showing` covers the pinned card, which has no such gap — it is on
   * screen from the click, before any record exists — and covers the idle
   * buttons beside it too, whose native tooltip would otherwise open over a
   * card they have nothing to do with.
   *
   * `.wt-btn__label` is `display:none` in the narrow header, so this is the
   * only text left there; dropping it for the whole of a sub-second fetch, or
   * for the gap before main registers the operation, left a spinning button
   * that explained nothing.
   */
  const busyTitle = (
    kind: Exclude<Busy, null>,
    idle: string
  ): { title?: string } =>
    status.showing || carriesCard(kind)
      ? {}
      : { title: running === kind ? busyLabel(kind) : idle };
  const dirty = state?.dirty ?? worktree.dirty;
  // The same fact the chip beside the button reads as "no upstream". The live
  // snapshot when it is this checkout's; the indexed row until one arrives.
  // Neither is authoritative — `onPush` also answers Git's own `no_upstream`
  // with the same question, for the case where both were stale. A checkout
  // whose directory is gone reads `hasUpstream: false` too, and publishing is
  // no remedy for that, so it keeps the plain push and Git's own refusal.
  const live = state?.worktreeId === worktree.id ? state : null;
  const unpublished =
    worktree.branch !== null &&
    (live?.missing ?? worktree.missing) !== true &&
    (live !== null ? !live.hasUpstream : worktree.tracking === "unpublished");
  const behind = state?.behind ?? worktree.behind;
  const drift = defaultBranchDrift(state, worktree);

  return (
    <div className="wt-header">
      {/* Repo › branch › path moved up into the window strip (features/chrome/
          TitleBar.tsx). What's left is live worktree state and the git actions
          — hence __state, not __id — keeping this row's container-query
          degrade ladder. */}
      <div className="wt-header__state">
        {dirty > 0 && <span className="badge badge--warn">●{dirty}</span>}
        {/* Repo fact, not sync state, so it sits with the dirty badge on the
            left rather than among the chips the action buttons act on. */}
        <GitLfsChip
          repoId={repo.id}
          repoName={repo.name}
          repoPath={repo.path}
          worktreeId={worktree.id}
        />
        {/* The one repo-level fact the action buttons cannot act on: this
            account may not push here. A button, unlike the sidebar's mark,
            because this is where the push it is about lives. Hidden while an
            operation runs, like the drift chip beside it — the progress label
            needs that width. */}
        {noPushTitle !== null && running === null && (
          <button
            type="button"
            className="sync-chip sync-chip--readonly"
            {...hoverTooltip(tip, noPushTitle)}
            onClick={() => setForkPrompt({})}
          >
            read-only
          </button>
        )}
        <span style={{ flex: 1 }} />
        {/* Left of the sync chip, which stays adjacent to the buttons it maps
            onto. Hidden while ANY remote operation runs (not just a pull, as
            it once was) so the progress label keeps the width it
            ellipsizes into; on width it outlives the sync chip (see the
            container queries — ↓behind has the Pull accent, drift has nothing
            else). */}
        {drift !== null && running === null && (
          <span
            className="sync-chip sync-chip--drift"
            {...hoverTooltip(tip, drift.title)}
          >
            {drift.text}
          </span>
        )}
        <span
          ref={cardChip}
          className={`sync-chip sync-chip--${chip.tone}${
            running !== null ? " sync-chip--progress" : ""
          }`}
          role={running !== null ? "status" : undefined}
          // Pointer only: the chip is not focusable, and making a live status
          // a tab stop would buy the keyboard nothing the working button below
          // does not already offer.
          {...(running === null || !couldCarryCard(running)
            ? {}
            : {
                onMouseEnter: (event: { currentTarget: HTMLElement }) =>
                  status.open(event.currentTarget),
                onMouseLeave: status.close
              })}
        >
          {chip.text}
        </span>

        <div className="wt-actions">
          {/* The labels and sync chip collapse away in narrow headers, so the
              icon itself has to carry the busy state. aria-label keeps the
              accessible name when the label span is display:none.

              Two busy treatments, one rule: a circular arrow spins in place,
              and any other glyph swaps to the ring. Fetch's arrow IS a
              rotation, so rotating it is the literal reading and the button
              keeps its identity while it works; Pull's ↓ and Push's ↑ are not,
              and spinning them would read as broken. The accent tint that says
              "busy" is shared by all three and lives in app.css, keyed off
              aria-busy so it survives prefers-reduced-motion.

              `disabled` used to be set here while any of the three ran.
              Chromium blurs an element the moment it becomes disabled, so
              pressing Fetch from the keyboard threw focus to <body> for the
              length of the fetch (SC 2.4.3) — the same bug already fixed on
              .wt-refresh and .ref-fetch-all. aria-disabled says the same thing
              and keeps the button focusable; the guards below make them
              inert. */}
          <button
            className="wt-btn"
            onClick={(event) => {
              if (running !== null) return;
              pinStatus("fetch", event.currentTarget);
              onFetch();
            }}
            aria-disabled={running !== null}
            aria-label={running === "fetch" ? busyLabel("fetch") : "Fetch"}
            aria-busy={running === "fetch"}
            /* Title comes from busyTitle: a button that carries the status
               card gets none, because a native tooltip would cover the card
               it summons. */
            {...busyTitle("fetch", "Fetch")}
            {...statusTrigger("fetch")}
          >
            <RefreshGlyph />
            <span className="wt-btn__label">
              {running === "fetch" ? busyLabel("fetch") : "Fetch"}
            </span>
          </button>

          <button
            className={`wt-btn wt-btn--pull${behind > 0 ? " is-behind" : ""}`}
            onClick={(event) => {
              if (running !== null) return;
              pinStatus("pull", event.currentTarget);
              onPull();
            }}
            aria-disabled={running !== null}
            aria-label={running === "pull" ? busyLabel("pull") : "Pull"}
            aria-busy={running === "pull"}
            {...busyTitle("pull", "Pull · fetch + fast-forward")}
            {...statusTrigger("pull")}
          >
            {running === "pull" ? (
              <span className="wt-btn__spinner" />
            ) : (
              <PullGlyph />
            )}
            <span className="wt-btn__label">
              {running === "pull" ? busyLabel("pull") : "Pull"}
            </span>
          </button>

          <button
            className="wt-btn"
            onClick={(event) => {
              if (running !== null) return;
              pushTarget.current = event.currentTarget;
              // Nowhere for a plain push to go: ask, rather than let Git refuse
              // and hand the user a command to run in a terminal. No card yet
              // — nothing is running until the question is answered.
              if (unpublished) {
                void askWhereToPublish();
                return;
              }
              pinStatus("push", event.currentTarget);
              onPush();
            }}
            aria-disabled={running !== null}
            aria-label={running === "push" ? busyLabel("push") : "Push"}
            aria-busy={running === "push"}
            {...busyTitle(
              "push",
              // The label stays "Push" — a button that renamed itself would
              // shift the toolbar — and the tooltip says what it will ask.
              unpublished ? "Push · publish this branch to a remote…" : "Push"
            )}
            {...statusTrigger("push")}
          >
            {running === "push" ? (
              <span className="wt-btn__spinner" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20V9" />
                <path d="m7 14 5-5 5 5" />
                <path d="M5 4h14" />
              </svg>
            )}
            <span className="wt-btn__label">
              {running === "push" ? busyLabel("push") : "Push"}
            </span>
          </button>
        </div>
        {status.node}
        <WorktreeMenu
          className="kebab--toolbar"
          worktree={worktree}
          onResetToRemote={() =>
            openResetToRemote({
              worktree,
              onComplete: (mode, remoteBranch) =>
                showFlash(
                  {
                    text: `${mode} reset to ${remoteBranch}`,
                    tone: mode === "hard" ? "warn" : "ok"
                  },
                  2600
                )
            })
          }
        />
      </div>
      {sshRecovery !== null && (
        <SshRemoteRecoveryDialog
          worktreeId={id}
          operation={sshRecovery.operation}
          recovery={sshRecovery.recovery}
          onClose={() => setSshRecovery(null)}
          onChanged={() => {
            setSshRecovery(null);
            showFlash(
              {
                text: `${sshRecovery.recovery.remote} now uses SSH`,
                tone: "ok"
              },
              2400
            );
          }}
        />
      )}
      {publishing !== null && worktree.branch !== null && (
        <PublishBranchDialog
          branch={worktree.branch}
          remotes={publishing}
          onClose={() => setPublishing(null)}
          onPublish={(target) => {
            setPublishing(null);
            // The card hangs off the button that asked, exactly as it would
            // have for a plain push — opened now, because this is the moment
            // something starts running.
            const from = pushTarget.current;
            if (from !== null && from.isConnected) pinStatus("push", from);
            onPush(target);
          }}
        />
      )}
      {forkPrompt !== null && (
        <ForkCheckoutDialog
          profileId={repo.profileId}
          repoId={repo.id}
          repoName={repo.identity?.nameWithOwner ?? repo.name}
          {...(forkPrompt.reason === undefined
            ? {}
            : { reason: forkPrompt.reason })}
          onClose={() => setForkPrompt(null)}
          onForked={() => {
            setForkPrompt(null);
            // The repo row is unchanged — same folder, same name — so the
            // flash names the thing that did move.
            showFlash({ text: "origin is now your fork", tone: "ok" }, 2600);
          }}
        />
      )}
      {divergence !== null && (
        <PullDivergenceDialog
          divergence={divergence}
          busy={recoveryBusy}
          onClose={() => setDivergence(null)}
          onRebase={() => void recover("rebase")}
          onReset={() => void recover("reset")}
          onResetElsewhere={() => {
            setDivergence(null);
            openResetToRemote({ worktree });
          }}
        />
      )}
      {tip.tooltipNode}
    </div>
  );
}
