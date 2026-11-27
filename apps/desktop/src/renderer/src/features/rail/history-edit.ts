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
 * The proof ledger: the same three rows for every plan.
 * Only the first is known before the check; the other two come from the
 * isolated replay.
 */
export function ledgerRows(
  commits: RebaseCommitRef[],
  check: LedgerCheck
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
        value: `${check.proof.steps} steps · ${seconds(check.proof.durationMs)}`
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
