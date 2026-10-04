import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import type {
  RepositorySetup,
  ForkSourceTarget,
  ForkStatus,
  ForkSyncOutcome,
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
import { dispatch, subscribe } from "../../lib/pwrgit";
import { PullGlyph } from "../../lib/PullGlyph";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { dismissToastKey, showErrorToast, showInfoToast } from "../../lib/toast";
import {
  remoteActivityPhaseLabel,
  type RemoteActivityScope
} from "../remote/remote-activity";
import { useRemoteActivityPopover } from "../remote/useRemoteActivityPopover";
import { useRemoteActivityFor } from "../../state/useRemoteActivity";
import { useForkStatus } from "../../state/useForkStatus";
import { WorktreeMenu } from "../shell/WorktreeMenu";
import { GitLfsChip } from "./GitLfsChip";
import { PullDivergenceDialog } from "./PullDivergenceDialog";
import { PullMenu, type PullMenuRow } from "./PullMenu";
import { readPullChoice, writePullChoice, type PullChoice } from "./pull-choice";
import { openResetToRemote } from "./reset-to-remote";
import { SshRemoteRecoveryDialog } from "./SshRemoteRecoveryDialog";
import { ForkCheckoutDialog } from "../sidebar/ForkCheckoutDialog";
import { ForkRouteLine } from "../sidebar/ForkRoute";
import {
  ForkTrackingRecoveryDialog,
  type ForkTrackingDone,
  type ForkTrackingEntry
} from "../sidebar/ForkTrackingRecoveryDialog";
import { PublishBranchDialog } from "./PublishBranchDialog";
import { GitForkIcon, pushAccessTitle } from "../sidebar/RepoIdentityMarks";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { useFitLadder } from "../../lib/useFitLadder";

/**
 * The sync chip. `mid` and `short` are what it says once the header has
 * stepped down (see `HEADER_FIT_STEPS`); they are drawn by CSS from data
 * attributes, so the chip's text in the DOM stays the whole sentence.
 *
 * `source` is the fork's source having commits for this branch: the sidebar's
 * `.badge--source` look (accent outline, fork glyph leading at every step), so
 * the header and the row beside it say one fact one way. `warn`'s fill stays
 * the user's own remote having them (Fork Sync 3e rule 2, Post-ship 2a).
 */
type Chip = {
  text: string;
  tone: "muted" | "ok" | "warn" | "source";
  mid?: string;
  short?: string;
};

/**
 * What the header gives up, in order, as it runs out of width. Measured, not
 * fixed: the chip's width depends on the count and the remote's name, and a
 * container-query constant hid `↓25 behind upstream` at the stock window width
 * with room to spare (Fork Sync turn 3, 3a). Labels go first because the
 * buttons keep their icons and tooltips; the sync chip is information and
 * outlasts them, shortening before it goes. Once it goes, Pull's accent is
 * what is left of it. The drift and read-only chips come after it, as they
 * did before: nothing else in the header carries their signal.
 */
const HEADER_FIT_STEPS = [
  "fit-icons",
  "fit-chip-mid",
  "fit-chip-short",
  "fit-no-lfs",
  "fit-no-chip",
  "fit-no-drift",
  "fit-no-readonly"
] as const;

function baseChip(
  state: WorktreeState | null,
  worktree: Worktree,
  source: SourceCounts | null
): Chip {
  // A gone checkout outranks every sync reading: nothing below is true of a
  // directory that does not exist. Read it from this worktree's own row when
  // the live snapshot still belongs to the previous selection.
  const missing =
    state?.worktreeId === worktree.id ? state.missing : worktree.missing;
  if (missing === true) return { text: "directory missing", tone: "warn" };
  // The source's count needs nothing from the live snapshot, so it does not
  // wait for one: on a fork's first paint it may be all there is.
  const fromSource = source === null ? null : forkSourceChip(source);
  if (fromSource !== null) return fromSource;
  if (state === null) return { text: "…", tone: "muted" };
  if (state.behind > 0) {
    const ahead = state.ahead > 0 ? ` · ↑${state.ahead}` : "";
    return {
      text: `↓${state.behind} behind${ahead}`,
      tone: "warn",
      mid: `↓${state.behind}${ahead}`
    };
  }
  if (state.ahead > 0) {
    return { text: `↑${state.ahead} ahead`, tone: "ok", mid: `↑${state.ahead}` };
  }
  if (!state.hasUpstream) return { text: "no upstream", tone: "muted" };
  // Git names the upstream but has nothing to count against: its remote
  // branch was deleted. "up to date" was what this used to say.
  if (state.upstreamGone === true) {
    return { text: "upstream gone", tone: "muted" };
  }
  return { text: "up to date", tone: "muted" };
}

/**
 * The chip's tooltip at rest: the state in words, and on a fork, which
 * repository `upstream` is — the chip alone never said.
 */
function chipExplanation(
  state: WorktreeState | null,
  fork: Pick<ForkStatus, "tracked"> & {
    source: (SourceCounts & { label: string; parent?: string }) | null;
  } | null,
  branch: string
): string | undefined {
  const source = fork?.source ?? null;
  if (source !== null && source.behind > 0) {
    const who =
      source.parent === undefined
        ? `${source.remote} is the remote PwrGit takes to be this fork's source.`
        : `${source.remote} is ${source.parent}, the repository this fork came from.`;
    const own =
      source.ahead > 0
        ? ` ${branch} also has ${commits(source.ahead)} ${source.label} doesn't.`
        : "";
    const tracked = fork?.tracked ?? null;
    const trackedLine =
      tracked === null
        ? ""
        : tracked.ahead === 0 && tracked.behind === 0
          ? ` ${tracked.label}, your fork, matches ${branch}.`
          : ` ${tracked.label}, your fork: ↓${tracked.behind} ↑${tracked.ahead}.`;
    return `${who} ${branch} is ${commits(source.behind)} behind ${source.label}.${own}${trackedLine}`;
  }
  if (state === null) return undefined;
  if (state.behind > 0) {
    return `${commits(state.behind)} to pull from the branch ${branch} tracks` +
      (state.ahead > 0 ? `, and ${commits(state.ahead)} to push` : "");
  }
  if (state.ahead > 0) return `${commits(state.ahead)} to push`;
  if (!state.hasUpstream) return `${branch} tracks nothing yet — Push publishes it`;
  if (state.upstreamGone === true) {
    return `The remote branch ${branch} tracked was deleted, usually because the work landed`;
  }
  return `${branch} matches the branch it tracks`;
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

function commits(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

/**
 * The status chip on a branch the fork's source also carries, once the source
 * has moved on. The chip otherwise compares the branch with the one it tracks,
 * and on a fork that is the user's own copy: `origin/main` reads "up to date"
 * while the source is ten commits ahead of both. So here the source is the
 * number that matters, and the tracked branch only comes up once the source
 * has nothing new — as `↑N ahead`, the commits a push would carry.
 */
/** What the chip needs of the source: the live read's `ForkSourceTarget`, or
 *  the stored `WorktreeForkSource` it paints from until that read lands. */
type SourceCounts = Pick<ForkSourceTarget, "remote" | "ahead" | "behind">;

function forkSourceChip(source: SourceCounts): Chip | null {
  if (source.behind <= 0) return null;
  return source.ahead > 0
    ? {
        text: `↓${source.behind} ${source.remote} · ↑${source.ahead}`,
        tone: "source",
        short: `↓${source.behind} · ↑${source.ahead}`
      }
    : {
        text: `↓${source.behind} behind ${source.remote}`,
        tone: "source",
        mid: `↓${source.behind} ${source.remote}`,
        short: `↓${source.behind}`
      };
}

/** A fork branch with somewhere on the source to pull from, and a branch of
 *  its own to fall back on — the only place Pull has a choice to offer. */
type ForkChoice = ForkStatus & {
  source: ForkSourceTarget;
  tracked: NonNullable<ForkStatus["tracked"]>;
};

function forkChoiceOf(fork: ForkStatus | null): ForkChoice | null {
  if (fork === null || fork.source === null || fork.tracked === null) return null;
  return fork as ForkChoice;
}

/** The branch has commits the source lacks and the source has moved on: no
 *  fast-forward reaches it, so a sync stops for a review. */
function hasOwnCommits(fork: ForkChoice): boolean {
  return fork.source.ahead > 0 && fork.source.behind > 0;
}

/** Where a rebase onto the source carries its result: the tracked branch,
 *  leased on the tip Git last fetched for it. */
function forkPushTarget(fork: ForkStatus): {
  remote: string;
  branch: string;
  label: string;
  head: string;
} | null {
  const { tracked, source } = fork;
  if (tracked === null) return null;
  return {
    remote: tracked.remote,
    branch:
      source?.pushBack?.branch ?? tracked.label.slice(tracked.remote.length + 1),
    label: tracked.label,
    head: tracked.head
  };
}

/**
 * The rows under Pull's arrow. The three choices are always there, so the
 * one Pull runs can always be changed. While the branch has commits the
 * source lacks, the two reviews that can reach the source anyway come first,
 * because they are what that state is asking for.
 */
function pullMenuRows(
  fork: ForkChoice,
  trackedBehind: number,
  choice: PullChoice,
  on: {
    pick: (choice: PullChoice) => void;
    rebase: () => void;
    reset: () => void;
  }
): { note?: ReactNode; actions: PullMenuRow[]; choices: PullMenuRow[] } {
  const { branch, source, tracked } = fork;
  const own = hasOwnCommits(fork);
  const stops = (
    <>
      <code>{branch}</code> has commits of its own, so this stops for the
      rebase review.
    </>
  );
  const choices: PullMenuRow[] = [
    {
      key: "sync",
      title: (
        <>
          Sync with <code>{source.label}</code>
        </>
      ),
      detail: own ? (
        stops
      ) : (
        <>
          Fast-forward <code>{branch}</code>
          {source.behind > 0 ? ` ${commits(source.behind)}` : ""}, then push{" "}
          {source.behind > 0 ? "them " : ""}to <code>{tracked.label}</code>.
        </>
      ),
      onSelect: () => on.pick("sync")
    },
    {
      key: "source",
      title: (
        <>
          Pull <code>{source.label}</code> only
        </>
      ),
      detail: own ? (
        stops
      ) : (
        <>
          Fast-forward <code>{branch}</code>. <code>{tracked.label}</code> stays
          where it is until you push.
        </>
      ),
      onSelect: () => on.pick("source")
    },
    {
      key: "tracked",
      title: (
        <>
          Pull <code>{tracked.label}</code> only
        </>
      ),
      detail:
        trackedBehind > 0
          ? `Your fork's own tip. ${commits(trackedBehind)} to bring in.`
          : "Your fork's own tip.",
      onSelect: () => on.pick("tracked")
    }
  ];
  if (!own) return { actions: [], choices };
  const pushes = choice !== "source";
  return {
    note: (
      <>
        <code>{branch}</code> has {commits(source.ahead)}{" "}
        <code>{source.label}</code> doesn't
      </>
    ),
    actions: [
      {
        key: "rebase",
        title: (
          <>
            Rebase onto <code>{source.label}</code>…
          </>
        ),
        detail: pushes ? (
          <>
            Keeps your {commits(source.ahead)} on top, then pushes the result
            to <code>{tracked.label}</code>, replacing what it holds.
          </>
        ) : (
          <>Keeps your {commits(source.ahead)} on top.</>
        ),
        onSelect: on.rebase
      },
      {
        key: "reset",
        title: (
          <>
            Reset to <code>{source.label}</code>…
          </>
        ),
        detail: (
          <>
            Your {commits(source.ahead)} leave <code>{branch}</code>. Opens the
            reset review with the source selected.
          </>
        ),
        onSelect: on.reset
      }
    ],
    choices
  };
}

/** What Pull says it will do, in its tooltip — the button keeps its label. */
function pullTitle(choice: PullChoice, fork: ForkChoice | null): string {
  if (fork === null || choice === "tracked") {
    return fork === null
      ? "Pull · fetch + fast-forward"
      : `Pull ${fork.tracked.label} · fetch + fast-forward`;
  }
  const { branch, source, tracked } = fork;
  if (hasOwnCommits(fork)) {
    return `Pull · ${branch} has ${commits(source.ahead)} ${source.label} doesn't, so this stops for a rebase review`;
  }
  return choice === "sync"
    ? `Pull · fast-forward ${branch} to ${source.label}, then push to ${tracked.label}`
    : `Pull · fast-forward ${branch} to ${source.label}; ${tracked.label} waits for Push`;
}

/**
 * What a finished fork sync says on its card. `stands` keeps the card up
 * until dismissed: a push that failed, a push held back because the tracked
 * branch has commits the source lacks, and stash conflicts all leave the user
 * something to do.
 */
function forkSyncReceipt(
  outcome: ForkSyncOutcome,
  branch: string
): { summary: string; flash: Chip; stands: boolean } {
  const moved = `Fast-forwarded ${branch} to ${outcome.source} · ${commits(outcome.arrived)}`;
  const { push } = outcome;
  let summary = moved;
  let pushFailed = false;
  let notPushed = false;
  if (push.outcome === "pushed") {
    summary = `${moved} · pushed to ${push.remote}/${push.branch}`;
  } else if (push.outcome === "diverged") {
    notPushed = true;
    summary = `${moved} · ${push.remote}/${push.branch} has ${commits(push.overwrites)} ${outcome.source} doesn't, so it was not pushed`;
  } else if (push.outcome === "failed") {
    pushFailed = true;
    summary = `${moved}, but pushing ${push.remote}/${push.branch} failed — ${push.message.split("\n")[0]}`;
  } else if (push.outcome === "skipped") {
    summary = `${moved} · ${push.remote}/${push.branch} not pushed`;
  }
  if (outcome.reappliedWithConflicts) {
    return {
      summary: `${summary} · your stashed changes came back with conflicts`,
      flash: { text: "synced · resolve stash conflicts", tone: "warn" },
      stands: true
    };
  }
  if (outcome.stashed) summary = `${summary} · local changes stashed and reapplied`;
  return {
    summary,
    flash: pushFailed
      ? { text: "synced · push failed", tone: "warn" }
      : notPushed
        ? { text: "pulled · not pushed", tone: "warn" }
        : push.outcome === "skipped"
          ? { text: `pulled ${outcome.source}`, tone: "ok" }
          : { text: `synced with ${outcome.source}`, tone: "ok" },
    stands: pushFailed || notPushed
  };
}

type Busy = "fetch" | "pull" | "push" | null;
/** What an automatic remote check last concluded for a checkout's branch. */
type SettledRemoteCheck = "checked" | "untracked" | "unavailable";

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

/** One receipt at a time, taken down when the header moves to another
 *  checkout: its Push would otherwise act on whatever is shown next. */
const FORK_TRACKING_RECEIPT = "fork-tracking-receipt";

/** Where pushes go now, in the words the dialog used. After a refused push it
 *  carries that Push, one click away; the repair itself never pushes. */
function showTrackingReceipt(
  done: ForkTrackingDone,
  push: (() => void) | null
): void {
  // The title is drawn as an uppercase eyebrow, which would flatten a branch
  // name; the branch goes in the sentence.
  showInfoToast({
    key: FORK_TRACKING_RECEIPT,
    title: done.target.remote === "origin" ? "Now using your fork" : "Now using another fork",
    message: `${done.branch} pulls from and pushes to ${done.target.nameWithOwner}. Sync in the Pull menu still brings in ${done.parent}.`,
    ...(push === null ? {} : { action: { label: "Push", run: push } })
  });
}

export function WorktreeHeader({
  repo,
  worktree,
  state,
  onOpenSetup,
  onShowRail
}: {
  /** `profileId` and `identity` are here for the fork prompt: the first is
   *  what the fork command is scoped to, the second is what says this checkout
   *  cannot be pushed to. */
  repo: Pick<Repo, "id" | "name" | "path" | "profileId" | "identity">;
  worktree: Worktree;
  state: WorktreeState | null;
  onOpenSetup?: () => void;
  /** Set while the right-hand panel is collapsed: its reopen button is the
   *  last control in this row, where it takes its own width, rather than a
   *  floating button laid over Push and the kebab (Fork Sync 3c). */
  onShowRail?: () => void;
}) {
  const [repositorySetup, setRepositorySetup] = useState<RepositorySetup | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void dispatch("repo:setup", { repoId: repo.id }).then((result) => {
        if (active && result.ok) setRepositorySetup(result.value);
      });
    };
    setRepositorySetup(null);
    refresh();
    const off = subscribe("changes:changed", (event) => { if (event.worktreeId === worktree.id) refresh(); });
    return () => { active = false; off(); };
  }, [repo.id, worktree.id]);
  const [busy, setBusy] = useState<Busy>(null);
  const [divergence, setDivergence] = useState<RemoteDivergence | null>(null);
  /** Set while the divergence on screen is against the fork's source rather
   *  than the tracked branch: which ref it compared, and where a rebase then
   *  pushes (null when the choice was not to push). */
  const [divergenceFork, setDivergenceFork] = useState<{
    ref: string;
    pushTo: ReturnType<typeof forkPushTarget>;
  } | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<RecoveryBusy>(null);
  /** The HTTPS → SSH offer, and which operation Git refused for want of a
   *  credential — the dialog's copy is about that operation. */
  const [sshRecovery, setSshRecovery] = useState<{
    operation: Exclude<Busy, null>;
    recovery: SshRemoteRecovery;
  } | null>(null);
  /** The fork prompt, and why it opened. `tracking: null` is the user asking
   *  to fork; an entry opens the tracking repair from a refused push or from
   *  Pull's menu. */
  const [forkPrompt, setForkPrompt] = useState<{ tracking: ForkTrackingEntry | null } | null>(null);
  /** The Push button, for the receipt's own Push after a tracking repair. */
  const pushButton = useRef<HTMLButtonElement>(null);
  const shownWorktreeId = useRef(worktree.id);
  shownWorktreeId.current = worktree.id;
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
  const headerRef = useRef<HTMLDivElement>(null);
  const stateRowRef = useRef<HTMLDivElement>(null);
  const fitEndRef = useRef<HTMLSpanElement>(null);
  useFitLadder(headerRef, stateRowRef, fitEndRef, HEADER_FIT_STEPS);
  const [flash, setFlash] = useState<Chip | null>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimeout.current !== null) clearTimeout(flashTimeout.current);
  }, []);
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
  /** Where a card hangs when Pull runs from its menu rather than from a click
   *  on the button itself. */
  const pullButton = useRef<HTMLButtonElement | null>(null);
  /** The split Pull, so its menu opens under the whole control. */
  const pullSplit = useRef<HTMLDivElement>(null);
  /** A Pull clicked while the header is still seeded (below). */
  const pendingPull = useRef<{ key: string; from: HTMLElement | null } | null>(
    null
  );
  const forkRead = useForkStatus(worktree.id, repo.id, worktree.branch);
  const forkStatus = forkRead ?? null;
  /** Until the live read lands, the stored source the sidebar already draws
   *  from (Post-ship 2c). Selecting a fork's main used to paint "checking
   *  remote…" with a plain Pull, then swap in the chip and the 22px arrow
   *  ~300ms later, moving Push and the kebab under the pointer. Whether a
   *  branch has a counterpart on the source only changes when a remote does,
   *  so the stored answer is safe to paint; the live read can then only
   *  correct the digits, or take the arrow away on a real change of state. */
  const seed = forkRead === undefined ? (worktree.source ?? null) : null;
  /** The split Pull the live read would draw — a source to pull from and a
   *  tracked branch to fall back on — painted from the stored row. */
  const seedSplit =
    seed !== null &&
    worktree.tracking !== "unpublished" &&
    worktree.tracking !== "upstream_missing";
  /** What Pull does on a fork branch the source carries. Per repository, and
   *  re-read when the header moves to another one — it stays mounted. */
  const [pullChoice, setPullChoice] = useState<PullChoice>(() =>
    readPullChoice(repo.id)
  );
  useEffect(() => {
    setPullChoice(readPullChoice(repo.id));
  }, [repo.id]);

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
    // A receipt offering Push belongs to the checkout it repaired.
    dismissToastKey(FORK_TRACKING_RECEIPT);
    setPublishing(null);
    setDivergenceFork(null);
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
  // The automatic remote check behind "up to date". What it last settled is
  // remembered per checkout and branch, so a recheck — every minute, or on
  // coming back to a worktree — keeps the chip steady instead of flickering
  // through "checking remote…" each time.
  const settledChecks = useRef(new Map<string, SettledRemoteCheck>());
  const [remoteCheck, setRemoteCheck] = useState<{
    key: string;
    checking: boolean;
  } | null>(null);
  // Bumped when a remote operation on this checkout ends: the user's own
  // fetch supersedes the background check, so ask again once it is done.
  const [checkEpoch, setCheckEpoch] = useState(0);
  const hadActivity = useRef(false);
  useEffect(() => {
    if (hadActivity.current && activity === null) setCheckEpoch((n) => n + 1);
    hadActivity.current = activity !== null;
  }, [activity]);
  useEffect(() => {
    if (worktree.missing) return;
    const key = `${worktree.id}\0${worktree.branch}`;
    let active = true;
    const settle = (status: SettledRemoteCheck | "superseded"): void => {
      // Recorded even after this header has moved on: it is still the truth
      // about that branch, and coming back to it should start from it.
      if (status !== "superseded") settledChecks.current.set(key, status);
      if (active) setRemoteCheck({ key, checking: false });
    };
    const check = (): void => {
      setRemoteCheck({ key, checking: true });
      void dispatch("remote:checkSelected", { worktreeId: worktree.id })
        .then((result) => settle(result.ok ? result.value.status : "unavailable"))
        .catch(() => settle("unavailable"));
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [worktree.id, worktree.branch, worktree.missing, checkEpoch]);
  // The card and a tooltip must never share the screen. A click leaves the
  // pointer on the button whose tooltip is open, and the card it pins opens
  // right over it.
  const cardShowing = status.showing;
  useEffect(() => {
    if (cardShowing) tip.hide();
    // `tip.hide` is stable for the hook's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardShowing]);

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
    if (flashTimeout.current !== null) clearTimeout(flashTimeout.current);
    setFlash(chip);
    flashTimeout.current = setTimeout(() => {
      flashTimeout.current = null;
      setFlash(null);
    }, ms);
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

  const run = async <T,>(
    kind: Exclude<Busy, null>,
    fn: () => Promise<Result<T, PwrGitError>>,
    okChip: Chip,
    okSummary: string | ((value: T) => string),
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
      status.settle({
        status: "ok",
        summary:
          typeof okSummary === "string" ? okSummary : okSummary(result.value)
      });
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
      // Name what was asked: on a fork a plain Fetch asks the source too, and
      // a receipt that read the same either way could not say so. Only what
      // was asked: "refs and tags are up to date" was said even after a fetch
      // brought in 25 commits. The chip says what moved (Post-ship 2f).
      ({ remotes }) =>
        remotes.length === 0 ? "Fetched" : `Fetched ${remotes.join(" + ")}`,
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

  const reviewForkReset = (sourceRef: string): void => {
    openResetToRemote({
      worktree,
      preselectRef: sourceRef,
      onComplete: (mode, remoteBranch) =>
        showFlash(
          {
            text: `${mode} reset to ${remoteBranch}`,
            tone: mode === "hard" ? "warn" : "ok"
          },
          2600
        )
    });
  };

  /**
   * Compare the branch with the fork's source and open the recovery dialog
   * aimed at it. The fork status is read again alongside: a sync has just
   * fetched, and the tracked tip the rebase's push is leased on has to be the
   * one Git holds now, not the one the header last drew. `current` is the
   * operation it belongs to: a Pull started meanwhile supersedes it, and the
   * dialog never opens over that Pull.
   */
  const reviewForkDivergence = async (
    worktreeId: string,
    sourceRef: string,
    push: boolean,
    current: () => boolean
  ): Promise<Result<void, PwrGitError>> => {
    const [inspected, fresh] = await Promise.all([
      dispatch("remote:inspectDivergence", { worktreeId, ref: sourceRef }),
      dispatch("remote:forkStatus", { worktreeId })
    ]);
    if (!current()) return { ok: true, value: undefined };
    if (!inspected.ok) return inspected;
    const pushTo =
      push && fresh.ok && fresh.value !== null ? forkPushTarget(fresh.value) : null;
    setDivergence(inspected.value);
    setDivergenceFork({ ref: sourceRef, pushTo });
    return { ok: true, value: undefined };
  };

  /**
   * Pull on a fork branch the source carries: fast-forward from the source,
   * then — for `sync` — the same commits on to the tracked branch. A branch
   * with commits of its own cannot fast-forward, and gets what a plain Pull
   * gets there: the dialog that compares the two histories, aimed at the
   * source.
   */
  const onSyncFork = (fork: ForkChoice, push: boolean): void => {
    const worktreeId = id;
    const current = beginOperation(worktreeId);
    setBusy("pull");
    void dispatch("remote:syncFork", {
      worktreeId,
      branch: fork.branch,
      sourceRef: fork.source.ref,
      push
    }).then(async (result) => {
      if (!current()) return;
      if (!result.ok) {
        if (
          result.error.kind === "remote" &&
          result.error.code === "not_fast_forward"
        ) {
          const reviewed = await reviewForkDivergence(
            worktreeId,
            fork.source.ref,
            push,
            current
          );
          if (!current()) return;
          setBusy(null);
          if (reviewed.ok) {
            // Modal, and it IS the outcome — the same rule as Pull's own
            // divergence dialog.
            status.dismiss();
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
      setBusy(null);
      const receipt = forkSyncReceipt(result.value, fork.branch);
      showFlash(receipt.flash, receipt.stands ? 4000 : 2400);
      status.settle({
        status: receipt.stands ? "error" : "ok",
        summary: receipt.summary
      });
    });
  };

  const recover = async (action: Exclude<RecoveryBusy, null>): Promise<void> => {
    if (divergence === null || recoveryInFlight.current !== null) return;
    // Against the source, a reset is the full review's: it shows what leaves
    // and can bring the fork's branch along, which the one-step reset cannot.
    if (divergenceFork !== null && action === "reset") {
      setDivergence(null);
      setDivergenceFork(null);
      reviewForkReset(divergenceFork.ref);
      return;
    }
    const worktreeId = id;
    const operation = ++recoveryOperation.current;
    recoveryInFlight.current = worktreeId;
    setRecoveryBusy(action);
    const snapshot = {
      worktreeId,
      branch: divergence.branch,
      head: divergence.head,
      upstreamHead: divergence.upstreamHead
    };
    const pushTo = divergenceFork?.pushTo ?? null;
    const result =
      action === "reset"
        ? await dispatch("remote:resetToUpstream", snapshot)
        : await dispatch("remote:rebaseOntoUpstream", {
            ...snapshot,
            ...(divergenceFork === null ? {} : { ref: divergenceFork.ref }),
            ...(pushTo === null
              ? {}
              : {
                  pushTo: {
                    remote: pushTo.remote,
                    branch: pushTo.branch,
                    expectedHead: pushTo.head
                  }
                })
          });
    if (
      recoveryOperation.current !== operation ||
      activeWorktreeId.current !== worktreeId
    ) {
      return;
    }
    recoveryInFlight.current = null;
    setRecoveryBusy(null);
    setDivergence(null);
    setDivergenceFork(null);
    if (!result.ok) {
      flashError(action === "rebase" ? "Rebase" : "Reset", result.error);
      return;
    }
    const push = result.value?.push ?? null;
    if (push?.outcome === "failed") {
      // The rebase stands; only the fork's branch was left behind, and it is
      // the user's to push once they know why.
      showFlash({ text: "rebased · push failed", tone: "warn" }, 4000);
      showErrorToast({
        title: "Push failed",
        message: `Rebased ${divergence.branch} onto ${divergence.upstream}, but pushing ${push.remote}/${push.branch} failed — ${push.message.split("\n")[0]}`,
        detail: push.message,
        subject: { repoId: repo.id }
      });
      return;
    }
    showFlash(
      {
        text:
          action === "reset"
            ? "reset to remote"
            : push?.outcome === "pushed"
              ? `rebased · pushed to ${push.remote}/${push.branch}`
              : divergenceFork !== null
                ? `rebased onto ${divergence.upstream}`
                : "rebased onto remote",
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
        setForkPrompt({ tracking: { from: "push", error: result.error.message.split("\n")[0] ?? "" } });
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
  // The live read is keyed to this checkout already (useForkStatus answers
  // undefined until it has read this one), so there is no stale-selection
  // case to guard.
  const forkChoice = forkChoiceOf(forkStatus);
  /** Pull is split: from the live read, or seeded from the stored source
   *  while that read is out. Only the live read can run anything. */
  const trackingRepair = forkStatus?.trackingRepair ?? null;
  const sourceSplit = forkChoice !== null || seedSplit;
  const split = sourceSplit || trackingRepair !== null;
  // A repair-only dropdown has no source operation. Keep plain Pull usable
  // without discarding the repository's saved choice for after repair.
  const choice: PullChoice = sourceSplit ? pullChoice : "tracked";
  const shownSource = forkStatus?.source ?? seed;
  const localChip = baseChip(state, worktree, shownSource);
  // "up to date" is only claimed once the remote has confirmed it. Until
  // then the chip says what is actually known.
  const checkKey = `${worktree.id}\0${worktree.branch}`;
  const settledCheck = settledChecks.current.get(checkKey) ?? null;
  const checkingRemote = remoteCheck?.key !== checkKey || remoteCheck.checking;
  const remoteUnverified =
    localChip.text === "up to date" &&
    (settledCheck === null || settledCheck === "unavailable");
  const checkedChip = !remoteUnverified
    ? localChip
    : checkingRemote
      ? { text: "checking remote…", tone: "muted" as const }
      : { text: "remote unchecked", tone: "muted" as const };
  const chip =
    running !== null
      ? { text: busyLabel(running), tone: "muted" as const }
      : (flash ?? checkedChip);
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
   * A tooltip everywhere the status card is NOT coming — the two must never
   * both appear, but a button with neither is worse than either. The house
   * tooltip rather than a native `title`: a native one waits a second and
   * more, and on a split Pull it was the only way to learn, before pressing,
   * that the button also pushes to the fork (Fork Sync 3b).
   *
   * That is `carriesCard`, not `couldCarryCard`: in the gap before the record
   * arrives the button is already listening for the hover that will summon a
   * card, and the tooltip is what covers exactly that gap — its handlers run
   * alongside the card's there, rather than replacing them. The two cannot
   * overlap on screen because the record that lets the card open is the same
   * record that drops the tooltip, in one render (and the effect below takes
   * down one already open).
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
  const buttonTriggers = (
    kind: Exclude<Busy, null>,
    idle: string
  ): StatusTriggerProps => {
    const trigger = statusTrigger(kind);
    if (status.showing || carriesCard(kind)) return trigger;
    const own = hoverTooltip(tip, running === kind ? busyLabel(kind) : idle);
    return {
      ...trigger,
      onMouseEnter: (event) => {
        own.onMouseEnter(event as Parameters<typeof own.onMouseEnter>[0]);
        trigger.onMouseEnter?.(event);
      },
      onMouseLeave: () => {
        tip.hide();
        trigger.onMouseLeave?.();
      },
      onFocus: (event) => {
        own.onFocus(event as Parameters<typeof own.onFocus>[0]);
        trigger.onFocus?.(event);
      },
      onBlur: () => {
        own.onBlur();
        trigger.onBlur?.();
      }
    };
  };
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
  // On a fork's feature branch the default that matters is the source's —
  // where the pull request lands — and the fork's own `main` can be stale by
  // exactly as much as the fork is. Falls back to the tracked remote's
  // default until the fork read lands, and on every repository that is not a
  // fork.
  const forkDrift = forkStatus?.drift ?? null;
  const drift =
    forkDrift === null
      ? defaultBranchDrift(state, worktree)
      : forkDrift.behind > 0
        ? {
            text: `${forkDrift.label} +${forkDrift.behind}`,
            title: `${forkDrift.label} has ${commits(forkDrift.behind)} not in ${forkStatus?.branch ?? worktree.branch}; it is where this branch's pull request lands, not commits available to pull`
          }
        : null;
  // Sync catches the branch up with everything it is behind. Once the source
  // has nothing new, that is the tracked branch — the same fallback the
  // status chip makes — and a fast-forward to the source would pull nothing
  // while the chip counts commits waiting on `origin/main`.
  const runs: PullChoice =
    choice === "sync" &&
    split &&
    (shownSource?.behind ?? 0) === 0 &&
    behind > 0
      ? "tracked"
      : choice;
  // The accent says pulling has something to do, so it follows what Pull
  // would pull from.
  const pullHasWork =
    !split || runs === "tracked"
      ? behind > 0
      : (shownSource?.behind ?? 0) > 0;
  const pullTrigger = buttonTriggers(
    "pull",
    forkChoice === null && seed !== null && split
      ? `Pull · checking ${seed.label}…`
      : pullTitle(runs, forkChoice)
  );

  /** Run what Pull does, from the button or from a row of its menu. */
  const runPull = (run: PullChoice, from: HTMLElement | null): void => {
    if (running !== null) return;
    // Seeded, not yet read: the sync needs the live tips to lease against,
    // and a plain pull in its place would do something the arrow does not
    // say. Hold the click for the read, which lands within a frame or two of
    // the selection, rather than drop it.
    if (forkChoice === null && seedSplit && run !== "tracked") {
      pendingPull.current = { key: checkKey, from };
      return;
    }
    if (from !== null) pinStatus("pull", from);
    if (forkChoice === null || run === "tracked") onPull();
    else onSyncFork(forkChoice, run === "sync");
  };
  // The held click runs once the read lands, as whatever Pull now runs, and
  // only for the checkout it was made on.
  useEffect(() => {
    const pending = pendingPull.current;
    if (pending === null || forkRead === undefined) return;
    pendingPull.current = null;
    if (pending.key === checkKey) runPull(runs, pending.from);
  });
  const pickPullChoice = (next: PullChoice): void => {
    setPullChoice(next);
    writePullChoice(repo.id, next);
    runPull(next, pullButton.current);
  };
  const pullMenu =
    trackingRepair !== null
      ? {
          note: <>
            <ForkRouteLine branch={trackingRepair.branch}
              original={repo.identity?.parent?.nameWithOwner ?? trackingRepair.upstream} />
            <br />
            {trackingRepair.branch} pulls from and pushes to the original, not your fork.
          </>,
          actions: [{
            key: "repair-tracking",
            title: <>Use your fork for <code>{trackingRepair.branch}</code>…</>,
            detail: repo.identity === undefined
              ? "Pull and push through your fork. Shows what changes first."
              : `Pull and push through ${repo.identity.nameWithOwner}. Shows what changes first.`,
            onSelect: () => setForkPrompt({ tracking: { from: "pull" } })
          }],
          choices: []
        }
      : forkChoice === null
      ? null
      : pullMenuRows(forkChoice, behind, choice, {
          pick: pickPullChoice,
          rebase: () => {
            if (running !== null) return;
            const worktreeId = id;
            const current = beginOperation(worktreeId);
            void reviewForkDivergence(
              worktreeId,
              forkChoice.source.ref,
              choice !== "source",
              current
            ).then((reviewed) => {
              if (!reviewed.ok && current()) {
                flashError("Rebase", reviewed.error, { onCard: false });
              }
            });
          },
          reset: () => reviewForkReset(forkChoice.source.ref)
        });

  return (
    <div className="wt-header" ref={headerRef}>
      {/* Repo › branch › path moved up into the window strip (features/chrome/
          TitleBar.tsx). What's left is live worktree state and the git actions
          — hence __state, not __id — keeping this row's container-query
          degrade ladder. */}
      <div className="wt-header__state" ref={stateRowRef}>
        {dirty > 0 && <span className="badge badge--warn">●{dirty}</span>}
        {/* Repo fact, not sync state, so it sits with the dirty badge on the
            left rather than among the chips the action buttons act on. */}
        <GitLfsChip
          repoId={repo.id}
          repoName={repo.name}
          repoPath={repo.path}
          worktreeId={worktree.id}
          hooksShadowed={repositorySetup?.hooks.lfsShadowed ?? false}
          {...(onOpenSetup === undefined ? {} : { onOpenSetup })}
        />
        {(repositorySetup?.hooks.active.length ?? 0) > 0 && <button type="button" className="discovery-hooks-chip" title={`${repositorySetup?.hooks.displayDirectory} · ${repositorySetup?.hooks.worktreeCount} worktrees`} onClick={onOpenSetup}>hooks {repositorySetup?.hooks.active.length}</button>}
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
            onClick={() => setForkPrompt({ tracking: null })}
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
          // The shorter forms the fit steps switch to, drawn by CSS so the
          // chip's own text stays the whole sentence.
          {...(chip.mid === undefined ? {} : { "data-mid": chip.mid })}
          {...(chip.short === undefined ? {} : { "data-short": chip.short })}
          // Pointer only: the chip is not focusable, and making a live status
          // a tab stop would buy the keyboard nothing the working button below
          // does not already offer. At rest it explains itself — on a fork,
          // which repository `upstream` is, which the chip alone never said.
          {...(running === null
            ? flash === null
              ? hoverTooltip(
                  tip,
                  remoteUnverified && !checkingRemote
                    ? "The network could not confirm the remote branch. PwrGit will retry quietly."
                    : remoteUnverified
                      ? "Checking the remote branch for new commits."
                      : chipExplanation(
                          state?.worktreeId === worktree.id ? state : null,
                          forkStatus ??
                            (seed === null ? null : { source: seed, tracked: null }),
                          forkStatus?.branch ?? worktree.branch
                        )
                )
              : {}
            : !couldCarryCard(running)
              ? {}
              : {
                  onMouseEnter: (event: { currentTarget: HTMLElement }) =>
                    status.open(event.currentTarget),
                  onMouseLeave: status.close
                })}
        >
          {chip.tone === "source" && (
            <span className="sync-chip__glyph" aria-hidden="true">
              <GitForkIcon size={11} />
            </span>
          )}
          <span className="sync-chip__text">{chip.text}</span>
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
            /* The tooltip comes from buttonTriggers: a button that carries the status
               card gets none, because a native tooltip would cover the card
               it summons. */
            {...buttonTriggers("fetch", "Fetch")}
          >
            <RefreshGlyph />
            <span className="wt-btn__label">
              {running === "fetch" ? busyLabel("fetch") : "Fetch"}
            </span>
          </button>

          {/* On a fork branch the source also carries, Pull is split: the
              button runs the remembered choice, and the arrow offers the
              others. Everywhere else there is one place to pull from, so there
              is nothing to choose and no arrow. */}
          {(() => {
            const pullButtonNode = (
              <button
                className={`wt-btn wt-btn--pull${pullHasWork ? " is-behind" : ""}${
                  split ? " wt-split__main" : ""
                }`}
                onClick={(event) => runPull(runs, event.currentTarget)}
                aria-disabled={running !== null}
                aria-label={running === "pull" ? busyLabel("pull") : "Pull"}
                aria-busy={running === "pull"}
                {...pullTrigger}
                ref={(element) => {
                  pullButton.current = element;
                  if (pullTrigger.ref !== undefined) pullTrigger.ref.current = element;
                }}
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
            );
            if (!split) return pullButtonNode;
            // While seeded the arrow is there (it holds its width from the
            // first frame) but has nothing to offer until the read lands.
            return (
              <div
                ref={pullSplit}
                className={`wt-split${pullHasWork ? " is-behind" : ""}`}
              >
                {pullButtonNode}
                <PullMenu
                  anchorRef={pullSplit}
                  disabled={running !== null || pullMenu === null}
                  checked={runs}
                  kept={choice}
                  {...(pullMenu ?? { actions: [], choices: [] })}
                />
              </div>
            );
          })()}

          <button
            ref={pushButton}
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
            {...buttonTriggers(
              "push",
              // The label stays "Push" — a button that renamed itself would
              // shift the toolbar — and the tooltip says what it will ask.
              unpublished ? "Push · publish this branch to a remote…" : "Push"
            )}
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
          // Not gated on the read-only answer, unlike the chip: the forge may
          // not have been asked yet, and the fork dialog reads `origin` itself.
          fork={{
            label: `Fork ${repo.identity?.nameWithOwner ?? repo.name}…`,
            onSelect: () => setForkPrompt({ tracking: null })
          }}
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
        {onShowRail !== undefined && (
          <button
            type="button"
            className="wt-btn wt-rail-reopen"
            aria-label="Show panel"
            {...hoverTooltip(tip, "Show the Changes panel")}
            onClick={() => {
              tip.hide();
              onShowRail();
            }}
          >
            {/* Lucide panel-right-open: the panel, and the way it comes back. */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M15 3v18" />
              <path d="m10 15-3-3 3-3" />
            </svg>
          </button>
        )}
        {/* Where the row's in-flow content ends: the fit steps (useFitLadder)
            take the first step at which this lands inside the row. */}
        <span ref={fitEndRef} className="wt-header__fit-end" aria-hidden="true" />
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
      {forkPrompt !== null && forkPrompt.tracking !== null && (
        <ForkTrackingRecoveryDialog
          repo={repo}
          worktreeId={worktree.id}
          entry={forkPrompt.tracking}
          onClose={() => setForkPrompt(null)}
          onRepaired={(done) => {
            const refused = forkPrompt.tracking?.from === "push";
            setForkPrompt(null);
            showTrackingReceipt(done, refused ? () => {
              // Only for the checkout it repaired, through the button's own
              // click path: busy guards, the publish question, the card.
              if (shownWorktreeId.current === worktree.id) pushButton.current?.click();
            } : null);
          }}
          onForked={() => {
            setForkPrompt(null);
            showFlash({ text: "origin is now your fork", tone: "ok" }, 2600);
          }}
        />
      )}
      {forkPrompt !== null && forkPrompt.tracking === null && (
        <ForkCheckoutDialog
          profileId={repo.profileId}
          repoId={repo.id}
          repoName={repo.identity?.nameWithOwner ?? repo.name}
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
          onClose={() => {
            setDivergence(null);
            setDivergenceFork(null);
          }}
          onRebase={() => void recover("rebase")}
          onReset={() => void recover("reset")}
          onResetElsewhere={() => {
            setDivergence(null);
            setDivergenceFork(null);
            openResetToRemote({ worktree });
          }}
          {...(divergenceFork === null
            ? {}
            : {
                fork: {
                  pushTo:
                    divergenceFork.pushTo === null
                      ? null
                      : {
                          label: divergenceFork.pushTo.label,
                          head: divergenceFork.pushTo.head
                        }
                }
              })}
        />
      )}
      {tip.tooltipNode}
    </div>
  );
}
