import type {
  HistoryEditProgram,
  RebaseCommitRef,
  RebaseProof,
  RebaseSnagDetail
} from "@pwrgit/shared";

/**
 * Pure helpers behind the Rebase tab: turning a program into what the rail
 * draws, and the operator's edits back into a program. The main process
 * re-validates everything these produce.
 */

export const short = (hash: string): string => hash.slice(0, 7);

/** Oldest first, which is the order programs and plans are written in. */
export function chronological(commits: RebaseCommitRef[]): RebaseCommitRef[] {
  return [...commits].reverse();
}

export function joinedSubjects(commits: RebaseCommitRef[]): string {
  return chronological(commits)
    .map((commit) => commit.subject)
    .join("\n\n");
}

export function squashProgram(
  commits: RebaseCommitRef[],
  message: string
): HistoryEditProgram {
  return {
    commits: [
      {
        members: chronological(commits).map((commit) => commit.hash),
        message
      }
    ]
  };
}

/** Operator edits on top of an agent's Tidy proposal. */
export type TidyEdits = {
  /** Members pulled out of their group back into their own commit. */
  separated: ReadonlySet<string>;
  /** Group messages the operator rewrote, by the proposal's commit index. */
  messages: ReadonlyMap<number, string>;
};

export const NO_EDITS: TidyEdits = { separated: new Set(), messages: new Map() };

/**
 * The program to check and apply. A separated member becomes its own commit
 * right after its group, with its original message (`message: null` replays
 * it as-is). A group's first member is its base and cannot be separated.
 */
export function tidyProgram(
  base: HistoryEditProgram,
  edits: TidyEdits
): HistoryEditProgram {
  const commits: HistoryEditProgram["commits"] = [];
  base.commits.forEach((commit, index) => {
    const [first, ...rest] = commit.members;
    if (first === undefined) return;
    const kept = [first, ...rest.filter((hash) => !edits.separated.has(hash))];
    commits.push({
      members: kept,
      message: edits.messages.get(index) ?? commit.message
    });
    for (const hash of rest) {
      if (edits.separated.has(hash)) commits.push({ members: [hash], message: null });
    }
  });
  return { commits };
}

/** Members only: what the isolated check actually proves. */
export function programShapeKey(program: HistoryEditProgram): string {
  return program.commits.map((commit) => commit.members.join("+")).join("|");
}

/**
 * Commits whose position relative to the others changed: everything outside
 * the longest run that kept its original order. That is the smallest honest
 * set — moving one commit ahead of three should tag one commit, not four.
 */
export function movedHashes(
  commits: RebaseCommitRef[],
  program: HistoryEditProgram
): Set<string> {
  const original = new Map(
    chronological(commits).map((commit, index) => [commit.hash, index])
  );
  const sequence = program.commits.flatMap((commit) => commit.members);
  const ranks = sequence.map((hash) => original.get(hash) ?? -1);
  // Patience-sorting LIS with back-pointers, O(n log n).
  const tails: number[] = [];
  const previous = new Array<number>(ranks.length).fill(-1);
  for (let i = 0; i < ranks.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranks[tails[mid]!]! < ranks[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const inOrder = new Set<number>();
  for (let i = tails[tails.length - 1] ?? -1; i !== -1; i = previous[i]!) {
    inOrder.add(i);
  }
  return new Set(sequence.filter((_, index) => !inOrder.has(index)));
}

export function subjectOf(message: string | null, fallback: string): string {
  if (message === null) return fallback;
  return message.split("\n")[0] ?? fallback;
}

export function bodyOf(message: string | null): string {
  if (message === null) return "";
  const at = message.indexOf("\n\n");
  return at === -1 ? "" : message.slice(at + 2).trim();
}

export type TidyRow = {
  hash: string;
  subject: string;
  role: "pick" | "fixup";
  separated: boolean;
  moved: boolean;
  canToggle: boolean;
};

export type TidyGroup = {
  /** Index into the proposal's commits, the key for message edits. */
  index: number;
  message: string;
  rows: TidyRow[];
};

/** The proposal as the rail draws it: groups newest first, each group's
 *  members oldest first under their base commit. */
export function tidyGroups(
  commits: RebaseCommitRef[],
  base: HistoryEditProgram,
  edits: TidyEdits
): TidyGroup[] {
  const subjects = new Map(commits.map((commit) => [commit.hash, commit.subject]));
  const moved = movedHashes(commits, tidyProgram(base, edits));
  return base.commits
    .map((commit, index): TidyGroup => {
      const members = commit.members;
      const message =
        edits.messages.get(index) ??
        commit.message ??
        subjects.get(members[0] ?? "") ??
        "";
      return {
        index,
        message,
        rows: members.map((hash, position) => {
          const separated = position > 0 && edits.separated.has(hash);
          return {
            hash,
            subject: subjects.get(hash) ?? short(hash),
            role: position === 0 || separated ? "pick" : "fixup",
            separated,
            moved: moved.has(hash),
            canToggle: position > 0
          };
        })
      };
    })
    .reverse();
}

export function resultCount(program: HistoryEditProgram): number {
  return program.commits.length;
}

export type PlanDiffLine = { kind: "del" | "add"; text: string };

/**
 * What a revision changed, member by member: each commit that moved to a
 * different group, or changed role, shows where it was and where it went.
 */
export function planDiff(
  commits: RebaseCommitRef[],
  before: HistoryEditProgram,
  after: HistoryEditProgram
): PlanDiffLine[] {
  const subjects = new Map(commits.map((commit) => [commit.hash, commit.subject]));
  const place = (program: HistoryEditProgram) => {
    const out = new Map<string, { base: string; role: string; group: string }>();
    for (const commit of program.commits) {
      const base = commit.members[0] ?? "";
      const group = subjectOf(commit.message, subjects.get(base) ?? short(base));
      commit.members.forEach((hash, index) => {
        out.set(hash, { base, role: index === 0 ? "pick" : "fixup", group });
      });
    }
    return out;
  };
  const was = place(before);
  const now = place(after);
  const lines: PlanDiffLine[] = [];
  for (const commit of chronological(commits)) {
    const a = was.get(commit.hash);
    const b = now.get(commit.hash);
    if (a === undefined || b === undefined) continue;
    if (a.base === b.base && a.role === b.role) continue;
    lines.push({ kind: "del", text: `${a.role} ${short(commit.hash)} → ${a.group}` });
    lines.push({ kind: "add", text: `${b.role} ${short(commit.hash)} → ${b.group}` });
  }
  return lines;
}

export type LedgerRow = {
  state: "ok" | "wait" | "bad";
  label: string;
  value: string;
};

export type LedgerCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "clean"; proof: RebaseProof }
  | { kind: "snag"; detail?: RebaseSnagDetail };

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The proof ledger: the same three rows for every plan, whoever wrote it.
 * Only the first is known before the check; the other two come from the
 * isolated replay.
 */
export function ledgerRows(
  commits: RebaseCommitRef[],
  check: LedgerCheck,
  revised = false
): LedgerRow[] {
  const ordered = chronological(commits);
  const range =
    ordered.length === 0
      ? ""
      : `${short(ordered[0]!.hash)}…${short(ordered[ordered.length - 1]!.hash)}`;
  const used: LedgerRow = {
    state: "ok",
    label: `${commits.length} commits, each used once`,
    value: range
  };
  if (check.kind === "clean") {
    return [
      used,
      { state: "ok", label: "Code unchanged at the tip", value: `tree ${short(check.proof.tree)}` },
      {
        state: "ok",
        label: "Replays cleanly",
        value: `${revised ? "re-checked" : `${check.proof.steps} steps`} · ${seconds(check.proof.durationMs)}`
      }
    ];
  }
  if (check.kind === "snag" && check.detail?.kind === "tree_changed") {
    const files = check.detail.files;
    const first = files[0];
    return [
      used,
      {
        state: "bad",
        label: `Code changed in ${files.length} file${files.length === 1 ? "" : "s"}`,
        value:
          first === undefined
            ? ""
            : `${first.path.split("/").pop() ?? first.path} +${first.added} −${first.removed}`
      },
      { state: "ok", label: "Replays cleanly", value: "replayed" }
    ];
  }
  if (check.kind === "snag" && check.detail?.kind === "conflict") {
    return [
      used,
      { state: "wait", label: "Code unchanged at the tip", value: "not reached" },
      {
        state: "bad",
        label: "Replays cleanly",
        value: `stopped at ${check.detail.step} of ${check.detail.total}`
      }
    ];
  }
  return [
    used,
    { state: "wait", label: "Code unchanged at the tip", value: "needs replay" },
    {
      state: "wait",
      label: "Replays cleanly",
      value: check.kind === "checking" ? "replaying…" : "not run"
    }
  ];
}
